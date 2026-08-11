//! HTTP client for the Speedrun.com API v1.
//!
//! Responsibilities, in order of importance:
//!  1. Never leak the API key — it travels only in the `X-API-Key` header and is
//!     never logged, never echoed into errors, never serialised to the frontend.
//!  2. Classify failures honestly (see [`crate::error::AppError`]).
//!  3. Stay inside the published rate limit, and back off when told to.

use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, USER_AGENT};
use reqwest::{Method, Response, StatusCode};
use serde::de::DeserializeOwned;

use super::models::{ApiErrorBody, Envelope, PagedEnvelope};
use super::rate_limit::RateLimiter;
use crate::error::{AppError, AppResult};

pub const API_BASE: &str = "https://www.speedrun.com/api/v1";
pub const WEB_BASE: &str = "https://www.speedrun.com";

/// The API's hard ceiling for `max` on collection endpoints.
pub const MAX_PAGE_SIZE: u32 = 200;

/// Non-standard status Speedrun.com uses for rate limiting.
const STATUS_RATE_LIMITED: u16 = 420;

pub struct SrcClient {
    http: reqwest::Client,
    limiter: Arc<RateLimiter>,
    max_retries: u32,
}

impl SrcClient {
    pub fn new(requests_per_minute: usize) -> AppResult<Self> {
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        // Speedrun.com asks API consumers to identify themselves.
        headers.insert(
            USER_AGENT,
            HeaderValue::from_static(concat!("SRCTools/", env!("CARGO_PKG_VERSION"))),
        );

        let http = reqwest::Client::builder()
            .default_headers(headers)
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .pool_idle_timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| AppError::Internal(format!("could not build HTTP client: {e}")))?;

        Ok(Self {
            http,
            limiter: Arc::new(RateLimiter::new(
                requests_per_minute.clamp(10, 200),
                Duration::from_secs(60),
            )),
            max_retries: 3,
        })
    }

    pub fn limiter(&self) -> Arc<RateLimiter> {
        Arc::clone(&self.limiter)
    }

    /// GET a single-resource endpoint and unwrap its `data` envelope.
    pub async fn get<T: DeserializeOwned>(&self, path: &str, api_key: Option<&str>) -> AppResult<T> {
        let body: Envelope<T> = self.request(Method::GET, path, api_key, None).await?;
        Ok(body.data)
    }

    /// GET one page of a collection endpoint.
    pub async fn get_page<T: DeserializeOwned>(
        &self,
        path: &str,
        api_key: Option<&str>,
    ) -> AppResult<PagedEnvelope<T>> {
        self.request(Method::GET, path, api_key, None).await
    }

    /// Walks a paginated collection until exhausted or `limit` items collected.
    ///
    /// `path` must already contain any filters; pagination parameters are
    /// appended here.
    pub async fn get_all<T: DeserializeOwned>(
        &self,
        path: &str,
        api_key: Option<&str>,
        limit: Option<usize>,
    ) -> AppResult<Vec<T>> {
        let mut out: Vec<T> = Vec::new();
        let mut offset: u32 = 0;
        let separator = if path.contains('?') { '&' } else { '?' };

        loop {
            let page_size = match limit {
                Some(l) => (l.saturating_sub(out.len()) as u32).min(MAX_PAGE_SIZE),
                None => MAX_PAGE_SIZE,
            };
            if page_size == 0 {
                break;
            }

            let url = format!("{path}{separator}max={page_size}&offset={offset}");
            let page: PagedEnvelope<T> = self.get_page(&url, api_key).await?;
            let received = page.data.len();
            out.extend(page.data);

            let exhausted = match &page.pagination {
                // Trust the advertised `next` link when present; otherwise fall
                // back to "a short page means the end".
                Some(p) => !p.has_next() || received == 0,
                None => true,
            };
            if exhausted || limit.is_some_and(|l| out.len() >= l) {
                break;
            }
            offset += received as u32;

            // Defensive stop: the API caps `offset` well below this.
            if offset > 10_000 {
                break;
            }
        }

        Ok(out)
    }

    /// PUT a JSON body, returning the unwrapped `data`.
    pub async fn put<T: DeserializeOwned>(
        &self,
        path: &str,
        api_key: &str,
        body: serde_json::Value,
    ) -> AppResult<T> {
        let env: Envelope<T> = self
            .request(Method::PUT, path, Some(api_key), Some(body))
            .await?;
        Ok(env.data)
    }

    /// DELETE a resource, returning the unwrapped `data`.
    ///
    /// Used only for run deletion, which the API restricts to the run's own
    /// submitter and the game's moderators.
    pub async fn delete<T: DeserializeOwned>(&self, path: &str, api_key: &str) -> AppResult<T> {
        let env: Envelope<T> = self
            .request(Method::DELETE, path, Some(api_key), None)
            .await?;
        Ok(env.data)
    }

    /// Issues a request with rate limiting and bounded exponential backoff.
    async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        api_key: Option<&str>,
        body: Option<serde_json::Value>,
    ) -> AppResult<T> {
        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{API_BASE}{path}")
        };

        let mut attempt: u32 = 0;
        loop {
            self.limiter.acquire().await;

            let mut req = self.http.request(method.clone(), &url);
            if let Some(key) = api_key {
                // The only place the secret is ever attached.
                let mut value = HeaderValue::from_str(key)
                    .map_err(|_| AppError::InvalidInput("API key contains invalid characters.".into()))?;
                value.set_sensitive(true);
                req = req.header(HeaderName::from_static("x-api-key"), value);
            }
            if let Some(b) = &body {
                req = req.json(b);
            }

            let result = req.send().await;
            attempt += 1;
            let is_last = attempt > self.max_retries;

            let response = match result {
                Ok(r) => r,
                Err(e) => {
                    // Transport failure: retry unless we are out of attempts.
                    let err: AppError = e.into();
                    if is_last {
                        return Err(err);
                    }
                    tracing::debug!(
                        attempt,
                        path = %redact_path(path),
                        "request failed, retrying: {}",
                        err
                    );
                    self.backoff(attempt).await;
                    continue;
                }
            };

            match self.classify(response, path).await {
                Ok(parsed) => return Ok(parsed),
                Err(err) => {
                    if !err.retryable() || is_last {
                        return Err(err);
                    }
                    if let AppError::RateLimited { retry_after_secs } = &err {
                        self.limiter
                            .penalise(Duration::from_secs(*retry_after_secs))
                            .await;
                    } else {
                        self.backoff(attempt).await;
                    }
                }
            }
        }
    }

    /// Turns an HTTP response into either a parsed body or a typed error.
    async fn classify<T: DeserializeOwned>(
        &self,
        response: Response,
        path: &str,
    ) -> AppResult<T> {
        let status = response.status();

        if status.is_success() {
            let text = response.text().await.map_err(AppError::from)?;
            return serde_json::from_str(&text).map_err(|e| AppError::Malformed {
                source_name: "Speedrun.com".into(),
                detail: format!("{e} (while reading {})", redact_path(path)),
            });
        }

        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());

        // Read the body for the API's own message, but never assume it is JSON.
        let body_text = response.text().await.unwrap_or_default();
        let api_message = serde_json::from_str::<ApiErrorBody>(&body_text)
            .ok()
            .and_then(|b| b.message)
            .unwrap_or_else(|| truncate(&body_text, 300));

        Err(match status.as_u16() {
            STATUS_RATE_LIMITED | 429 => AppError::RateLimited {
                retry_after_secs: retry_after.unwrap_or(60).clamp(1, 300),
            },
            401 => AppError::Unauthorized,
            403 => {
                // The API returns 403 both for a missing key and for a valid key
                // without sufficient rights; the message distinguishes them.
                if api_message.contains("API Key") || api_message.contains("user context") {
                    AppError::Unauthorized
                } else {
                    AppError::Forbidden
                }
            }
            404 => AppError::NotFound(if api_message.is_empty() {
                format!("Not found on Speedrun.com: {}", redact_path(path))
            } else {
                api_message
            }),
            s if (500..=599).contains(&s) => AppError::ServiceUnavailable { status: s },
            s => AppError::Api {
                status: s,
                message: if api_message.is_empty() {
                    status
                        .canonical_reason()
                        .unwrap_or("unknown error")
                        .to_string()
                } else {
                    api_message
                },
            },
        })
    }

    /// Exponential backoff with jitter, capped so the UI never appears hung.
    async fn backoff(&self, attempt: u32) {
        let base = 400u64 * 2u64.pow(attempt.min(4));
        let jitter = rand::random::<u64>() % 250;
        tokio::time::sleep(Duration::from_millis((base + jitter).min(8_000))).await;
    }
}

/// Placeholder for `StatusCode` reuse in tests.
#[allow(dead_code)]
fn is_client_error(s: StatusCode) -> bool {
    s.is_client_error()
}

/// Strips query strings before a path reaches a log line.
///
/// Nothing secret is passed as a query parameter, but paths can carry user IDs
/// and we keep logs free of incidental personal data.
fn redact_path(path: &str) -> &str {
    match path.find('?') {
        Some(i) => &path[..i],
        None => path,
    }
}

fn truncate(s: &str, max: usize) -> String {
    let trimmed = s.trim();
    if trimmed.len() <= max {
        return trimmed.to_string();
    }
    let mut end = max;
    while end > 0 && !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &trimmed[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_query_strings() {
        assert_eq!(redact_path("/runs?status=new&max=200"), "/runs");
        assert_eq!(redact_path("/games/abc"), "/games/abc");
    }

    #[test]
    fn truncate_respects_char_boundaries() {
        let s = "é".repeat(200);
        let out = truncate(&s, 11);
        assert!(out.ends_with('…'));
        assert!(out.len() <= 14);
    }
}
