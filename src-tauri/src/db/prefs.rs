//! User configuration: settings, rejection templates, favourite games, saved
//! panel layouts and keyboard bindings.
//!
//! Settings are stored as JSON text under a string key. The frontend owns the
//! shape of the settings object; Rust only reads the handful of keys it needs
//! (see [`Db::setting_u64`]), which keeps adding a UI preference from becoming
//! a schema migration.

use rusqlite::{params, OptionalExtension};

use super::{sql_err, Db, FavoriteGame, RejectionTemplate};
use crate::error::{AppError, AppResult};
use crate::util::{now_iso8601, sanitize_line, sanitize_text};

/// Upper bound on stored preference blobs, so a runaway layout cannot bloat
/// the database.
const MAX_VALUE_BYTES: usize = 256 * 1024;

impl Db {
    // --- Settings -----------------------------------------------------------

    pub fn setting_get(&self, key: &str) -> AppResult<Option<String>> {
        self.with_conn(|conn| {
            conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(sql_err)
        })
    }

    pub fn setting_set(&self, key: &str, value: &str) -> AppResult<()> {
        let key = key.trim();
        if key.is_empty() {
            return Err(AppError::InvalidInput("a setting needs a key".into()));
        }
        if value.len() > MAX_VALUE_BYTES {
            return Err(AppError::InvalidInput(format!(
                "that setting is too large to store ({} KB, limit {} KB)",
                value.len() / 1024,
                MAX_VALUE_BYTES / 1024
            )));
        }
        let now = now_iso8601();
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                                updated_at = excluded.updated_at",
                params![key, value, now],
            )
            .map_err(sql_err)?;
            Ok(())
        })
    }

    pub fn setting_delete(&self, key: &str) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM settings WHERE key = ?1", params![key])
                .map_err(sql_err)?;
            Ok(())
        })
    }

    /// All settings as a key/value map, sent to the frontend on boot.
    pub fn settings_all(&self) -> AppResult<std::collections::HashMap<String, String>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare("SELECT key, value FROM settings")
                .map_err(sql_err)?;
            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(sql_err)?;
            let mut map = std::collections::HashMap::new();
            for row in rows {
                let (k, v) = row.map_err(sql_err)?;
                map.insert(k, v);
            }
            Ok(map)
        })
    }

    /// Numeric setting with a fallback, for values Rust needs (rate limit, TTLs).
    ///
    /// A corrupt or non-numeric value falls back rather than failing startup.
    pub fn setting_u64(&self, key: &str, default: u64) -> u64 {
        self.setting_get(key)
            .ok()
            .flatten()
            .and_then(|v| v.trim().trim_matches('"').parse::<u64>().ok())
            .unwrap_or(default)
    }

    // --- Rejection templates ------------------------------------------------

    pub fn templates_list(&self) -> AppResult<Vec<RejectionTemplate>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, label, body, sort_order, builtin, created_at
                     FROM rejection_templates ORDER BY sort_order ASC, label ASC",
                )
                .map_err(sql_err)?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(RejectionTemplate {
                        id: row.get(0)?,
                        label: row.get(1)?,
                        body: row.get(2)?,
                        sort_order: row.get(3)?,
                        builtin: row.get::<_, i64>(4)? != 0,
                        created_at: row.get(5)?,
                    })
                })
                .map_err(sql_err)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(sql_err)?);
            }
            Ok(out)
        })
    }

    /// Creates or updates a template. An empty `id` generates one.
    pub fn template_save(
        &self,
        id: Option<&str>,
        label: &str,
        body: &str,
        sort_order: Option<i64>,
    ) -> AppResult<RejectionTemplate> {
        let label = sanitize_line(label, 80);
        let body = sanitize_text(body, 2000);
        if label.is_empty() {
            return Err(AppError::InvalidInput("a template needs a name".into()));
        }
        if body.is_empty() {
            return Err(AppError::InvalidInput(
                "a template needs a rejection message — Speedrun.com requires a reason".into(),
            ));
        }

        let id = match id.map(str::trim).filter(|s| !s.is_empty()) {
            Some(existing) => existing.to_string(),
            None => format!("tpl-{}", crate::util::now_iso8601().replace([':', '.', '-'], "")),
        };
        let now = now_iso8601();
        let order = sort_order.unwrap_or(1000);

        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO rejection_templates (id, label, body, sort_order, builtin, created_at)
                 VALUES (?1, ?2, ?3, ?4, 0, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                     label = excluded.label,
                     body = excluded.body,
                     sort_order = excluded.sort_order",
                params![id, label, body, order, now],
            )
            .map_err(sql_err)?;
            Ok(())
        })?;

        self.templates_list()?
            .into_iter()
            .find(|t| t.id == id)
            .ok_or_else(|| AppError::Database("the template could not be read back".into()))
    }

    pub fn template_delete(&self, id: &str) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM rejection_templates WHERE id = ?1", params![id])
                .map_err(sql_err)?;
            Ok(())
        })
    }

    /// Re-seeds the built-in templates without touching custom ones.
    pub fn templates_restore_builtins(&self) -> AppResult<Vec<RejectionTemplate>> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM rejection_templates WHERE builtin = 1", [])
                .map_err(sql_err)?;
            super::schema::seed_default_templates(conn)
        })?;
        self.templates_list()
    }

    /// Applies a new display order in one transaction.
    pub fn templates_reorder(&self, ids_in_order: &[String]) -> AppResult<()> {
        self.with_tx(|tx| {
            for (index, id) in ids_in_order.iter().enumerate() {
                tx.execute(
                    "UPDATE rejection_templates SET sort_order = ?1 WHERE id = ?2",
                    params![index as i64, id],
                )
                .map_err(sql_err)?;
            }
            Ok(())
        })
    }

    // --- Favourite games ----------------------------------------------------

    pub fn favorites_list(&self) -> AppResult<Vec<FavoriteGame>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT game_id, name, abbrev, cover_url, sort_order, added_at
                     FROM favorite_games ORDER BY sort_order ASC, name ASC",
                )
                .map_err(sql_err)?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(FavoriteGame {
                        game_id: row.get(0)?,
                        name: row.get(1)?,
                        abbrev: row.get(2)?,
                        cover_url: row.get(3)?,
                        sort_order: row.get(4)?,
                        added_at: row.get(5)?,
                    })
                })
                .map_err(sql_err)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(sql_err)?);
            }
            Ok(out)
        })
    }

    pub fn favorite_add(
        &self,
        game_id: &str,
        name: &str,
        abbrev: Option<&str>,
        cover_url: Option<&str>,
    ) -> AppResult<()> {
        let game_id = game_id.trim();
        if game_id.is_empty() {
            return Err(AppError::InvalidInput("a favourite needs a game id".into()));
        }
        let now = now_iso8601();
        self.with_conn(|conn| {
            let next: i64 = conn
                .query_row(
                    "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM favorite_games",
                    [],
                    |r| r.get(0),
                )
                .map_err(sql_err)?;
            conn.execute(
                "INSERT INTO favorite_games (game_id, name, abbrev, cover_url, sort_order, added_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(game_id) DO UPDATE SET
                     name = excluded.name,
                     abbrev = excluded.abbrev,
                     cover_url = excluded.cover_url",
                params![
                    game_id,
                    sanitize_line(name, 200),
                    abbrev.map(|a| sanitize_line(a, 40)),
                    cover_url,
                    next,
                    now
                ],
            )
            .map_err(sql_err)?;
            Ok(())
        })
    }

    pub fn favorite_remove(&self, game_id: &str) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM favorite_games WHERE game_id = ?1", params![game_id])
                .map_err(sql_err)?;
            Ok(())
        })
    }

    pub fn favorites_reorder(&self, ids_in_order: &[String]) -> AppResult<()> {
        self.with_tx(|tx| {
            for (index, id) in ids_in_order.iter().enumerate() {
                tx.execute(
                    "UPDATE favorite_games SET sort_order = ?1 WHERE game_id = ?2",
                    params![index as i64, id],
                )
                .map_err(sql_err)?;
            }
            Ok(())
        })
    }

    // --- Layouts and shortcuts ---------------------------------------------

    pub fn layout_get(&self, name: &str) -> AppResult<Option<String>> {
        self.with_conn(|conn| {
            conn.query_row("SELECT payload FROM layouts WHERE name = ?1", params![name], |r| {
                r.get(0)
            })
            .optional()
            .map_err(sql_err)
        })
    }

    pub fn layout_set(&self, name: &str, payload: &str) -> AppResult<()> {
        if payload.len() > MAX_VALUE_BYTES {
            return Err(AppError::InvalidInput("that layout is too large to store".into()));
        }
        let now = now_iso8601();
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO layouts (name, payload, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(name) DO UPDATE SET payload = excluded.payload,
                                                 updated_at = excluded.updated_at",
                params![name, payload, now],
            )
            .map_err(sql_err)?;
            Ok(())
        })
    }

    pub fn layout_delete(&self, name: &str) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM layouts WHERE name = ?1", params![name])
                .map_err(sql_err)?;
            Ok(())
        })
    }

    /// Custom key bindings, keyed by action name. Absent actions use the
    /// defaults compiled into the frontend.
    pub fn shortcuts_all(&self) -> AppResult<std::collections::HashMap<String, String>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare("SELECT action, binding FROM shortcuts")
                .map_err(sql_err)?;
            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(sql_err)?;
            let mut map = std::collections::HashMap::new();
            for row in rows {
                let (k, v) = row.map_err(sql_err)?;
                map.insert(k, v);
            }
            Ok(map)
        })
    }

    pub fn shortcut_set(&self, action: &str, binding: &str) -> AppResult<()> {
        let action = action.trim();
        let binding = binding.trim();
        if action.is_empty() {
            return Err(AppError::InvalidInput("a shortcut needs an action".into()));
        }
        let now = now_iso8601();
        self.with_conn(|conn| {
            if binding.is_empty() {
                // An empty binding means "back to the default".
                conn.execute("DELETE FROM shortcuts WHERE action = ?1", params![action])
                    .map_err(sql_err)?;
                return Ok(());
            }
            conn.execute(
                "INSERT INTO shortcuts (action, binding, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(action) DO UPDATE SET binding = excluded.binding,
                                                   updated_at = excluded.updated_at",
                params![action, binding, now],
            )
            .map_err(sql_err)?;
            Ok(())
        })
    }

    pub fn shortcuts_reset(&self) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM shortcuts", []).map_err(sql_err)?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_round_trip_and_overwrite() {
        let db = Db::open_in_memory().unwrap();
        db.setting_set("theme", "\"dark\"").unwrap();
        assert_eq!(db.setting_get("theme").unwrap().as_deref(), Some("\"dark\""));
        db.setting_set("theme", "\"light\"").unwrap();
        assert_eq!(db.setting_get("theme").unwrap().as_deref(), Some("\"light\""));
        assert_eq!(db.settings_all().unwrap().len(), 1);
        db.setting_delete("theme").unwrap();
        assert!(db.setting_get("theme").unwrap().is_none());
    }

    #[test]
    fn numeric_settings_fall_back_when_corrupt() {
        let db = Db::open_in_memory().unwrap();
        assert_eq!(db.setting_u64("rateLimit", 100), 100);
        db.setting_set("rateLimit", "60").unwrap();
        assert_eq!(db.setting_u64("rateLimit", 100), 60);
        db.setting_set("rateLimit", "\"75\"").unwrap();
        assert_eq!(db.setting_u64("rateLimit", 100), 75, "JSON-quoted numbers work");
        db.setting_set("rateLimit", "nonsense").unwrap();
        assert_eq!(db.setting_u64("rateLimit", 100), 100);
    }

    #[test]
    fn oversized_settings_are_refused() {
        let db = Db::open_in_memory().unwrap();
        let huge = "x".repeat(MAX_VALUE_BYTES + 1);
        assert!(db.setting_set("blob", &huge).is_err());
    }

    #[test]
    fn templates_require_a_name_and_a_body() {
        let db = Db::open_in_memory().unwrap();
        assert!(db.template_save(None, "", "body", None).is_err());
        assert!(db.template_save(None, "Label", "   ", None).is_err());
    }

    #[test]
    fn custom_templates_are_created_edited_and_deleted() {
        let db = Db::open_in_memory().unwrap();
        let created = db
            .template_save(None, "Mine", "Please resubmit.", Some(5))
            .unwrap();
        assert!(!created.builtin);

        let edited = db
            .template_save(Some(&created.id), "Mine v2", "Updated text.", Some(5))
            .unwrap();
        assert_eq!(edited.id, created.id);
        assert_eq!(edited.label, "Mine v2");

        db.template_delete(&created.id).unwrap();
        assert!(db.templates_list().unwrap().iter().all(|t| t.id != created.id));
    }

    #[test]
    fn restoring_builtins_keeps_custom_templates() {
        let db = Db::open_in_memory().unwrap();
        let mine = db.template_save(None, "Mine", "Body", None).unwrap();
        db.template_delete("builtin-duplicate").unwrap();

        let restored = db.templates_restore_builtins().unwrap();
        assert!(restored.iter().any(|t| t.id == "builtin-duplicate"));
        assert!(restored.iter().any(|t| t.id == mine.id), "custom template survives");
    }

    #[test]
    fn reordering_templates_persists() {
        let db = Db::open_in_memory().unwrap();
        let ids: Vec<String> = db
            .templates_list()
            .unwrap()
            .into_iter()
            .rev()
            .map(|t| t.id)
            .collect();
        db.templates_reorder(&ids).unwrap();
        let after: Vec<String> = db.templates_list().unwrap().into_iter().map(|t| t.id).collect();
        assert_eq!(after, ids);
    }

    #[test]
    fn favorites_are_added_once_and_ordered() {
        let db = Db::open_in_memory().unwrap();
        db.favorite_add("g1", "Game One", Some("g1"), None).unwrap();
        db.favorite_add("g2", "Game Two", None, None).unwrap();
        db.favorite_add("g1", "Game One Renamed", None, None).unwrap();

        let favs = db.favorites_list().unwrap();
        assert_eq!(favs.len(), 2, "re-adding updates instead of duplicating");
        assert_eq!(favs[0].game_id, "g1");
        assert_eq!(favs[0].name, "Game One Renamed");

        db.favorites_reorder(&["g2".into(), "g1".into()]).unwrap();
        assert_eq!(db.favorites_list().unwrap()[0].game_id, "g2");

        db.favorite_remove("g2").unwrap();
        assert_eq!(db.favorites_list().unwrap().len(), 1);
    }

    #[test]
    fn layouts_and_shortcuts_round_trip() {
        let db = Db::open_in_memory().unwrap();
        db.layout_set("queue", "{\"left\":320}").unwrap();
        assert_eq!(db.layout_get("queue").unwrap().as_deref(), Some("{\"left\":320}"));
        db.layout_delete("queue").unwrap();
        assert!(db.layout_get("queue").unwrap().is_none());

        db.shortcut_set("approve", "a").unwrap();
        assert_eq!(db.shortcuts_all().unwrap().get("approve").map(String::as_str), Some("a"));
        db.shortcut_set("approve", "  ").unwrap();
        assert!(
            !db.shortcuts_all().unwrap().contains_key("approve"),
            "clearing a binding restores the default"
        );

        db.shortcut_set("reject", "r").unwrap();
        db.shortcuts_reset().unwrap();
        assert!(db.shortcuts_all().unwrap().is_empty());
    }
}
