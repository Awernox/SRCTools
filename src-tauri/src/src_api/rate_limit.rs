//! Client-side rate limiting.
//!
//! Speedrun.com asks for roughly 100 requests per minute; exceeding it earns a
//! 420 response. Rather than reacting to rejections, we pace ourselves with a
//! token bucket so bursts (e.g. verifying 200 videos) degrade into a steady
//! stream instead of a wall of errors.

use std::collections::VecDeque;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::time::Instant;

/// Sliding-window limiter shared by every outbound Speedrun.com request.
pub struct RateLimiter {
    inner: Mutex<Window>,
    capacity: usize,
    window: Duration,
}

struct Window {
    hits: VecDeque<Instant>,
    /// Set when the server explicitly told us to back off; blocks all traffic
    /// until it elapses, regardless of the local window.
    penalty_until: Option<Instant>,
}

impl RateLimiter {
    /// `capacity` requests per `window`.
    pub fn new(capacity: usize, window: Duration) -> Self {
        Self {
            inner: Mutex::new(Window {
                hits: VecDeque::with_capacity(capacity),
                penalty_until: None,
            }),
            capacity,
            window,
        }
    }

    /// Blocks until another request may be issued, then records it.
    pub async fn acquire(&self) {
        loop {
            let wait = {
                let mut w = self.inner.lock().await;
                let now = Instant::now();

                // A server-imposed penalty outranks the local window.
                if let Some(until) = w.penalty_until {
                    if until > now {
                        Some(until - now)
                    } else {
                        w.penalty_until = None;
                        None
                    }
                } else {
                    None
                }
                .or_else(|| {
                    while w.hits.front().is_some_and(|t| now.duration_since(*t) >= self.window) {
                        w.hits.pop_front();
                    }
                    if w.hits.len() < self.capacity {
                        w.hits.push_back(now);
                        None
                    } else {
                        // Wait until the oldest hit ages out of the window.
                        w.hits
                            .front()
                            .map(|oldest| self.window - now.duration_since(*oldest))
                    }
                })
            };

            match wait {
                None => return,
                Some(d) => tokio::time::sleep(d.max(Duration::from_millis(25))).await,
            }
        }
    }

    /// Records a server-side rate-limit response, pausing all traffic.
    pub async fn penalise(&self, retry_after: Duration) {
        let mut w = self.inner.lock().await;
        let until = Instant::now() + retry_after;
        if w.penalty_until.is_none_or(|existing| existing < until) {
            w.penalty_until = Some(until);
        }
    }

    /// Requests issued within the current window — surfaced in the UI.
    pub async fn current_load(&self) -> (usize, usize) {
        let mut w = self.inner.lock().await;
        let now = Instant::now();
        while w.hits.front().is_some_and(|t| now.duration_since(*t) >= self.window) {
            w.hits.pop_front();
        }
        (w.hits.len(), self.capacity)
    }
}
