//! Local SQLite storage: API cache, moderation log, and user configuration.
//!
//! One connection, guarded by a mutex. SQLite handles a single-writer desktop
//! workload comfortably, and the mutex keeps the borrow rules simple while
//! WAL mode stops readers blocking the writer.
//!
//! Every method here is synchronous and short. Command handlers call them from
//! inside `spawn_blocking` (see `crate::commands`) so a slow disk can never
//! stall the UI thread.

pub mod cache;
pub mod history;
pub mod models;
pub mod prefs;
pub mod schema;

use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use rusqlite::Connection;

use crate::error::{AppError, AppResult};

pub use models::*;

/// Handle to the application database.
pub struct Db {
    conn: Mutex<Connection>,
    path: PathBuf,
}

impl Db {
    /// Opens (creating if needed) the database at `path` and applies the schema.
    pub fn open(path: impl AsRef<Path>) -> AppResult<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AppError::Database(format!(
                    "could not create the data directory {}: {e}",
                    parent.display()
                ))
            })?;
        }

        let conn = Connection::open(&path).map_err(|e| {
            AppError::Database(format!("could not open {}: {e}", path.display()))
        })?;
        schema::initialize(&conn)?;

        Ok(Self {
            conn: Mutex::new(conn),
            path,
        })
    }

    /// In-memory database, used by tests.
    #[cfg(test)]
    pub fn open_in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()
            .map_err(|e| AppError::Database(e.to_string()))?;
        schema::initialize(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path: PathBuf::from(":memory:"),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Runs `f` with the connection held.
    ///
    /// Kept crate-private: callers outside `db` go through the typed methods so
    /// SQL stays in one place.
    pub(crate) fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let guard = self.conn.lock();
        f(&guard)
    }

    /// Runs `f` inside a transaction, rolling back if it returns `Err`.
    pub(crate) fn with_tx<T>(
        &self,
        f: impl FnOnce(&rusqlite::Transaction<'_>) -> AppResult<T>,
    ) -> AppResult<T> {
        let mut guard = self.conn.lock();
        let tx = guard
            .transaction()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let out = f(&tx)?;
        tx.commit().map_err(|e| AppError::Database(e.to_string()))?;
        Ok(out)
    }

    /// Reclaims space after a large delete.
    pub fn vacuum(&self) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute_batch("VACUUM")
                .map_err(|e| AppError::Database(e.to_string()))
        })
    }

    /// Size of the database file on disk, when it is a real file.
    pub fn size_bytes(&self) -> Option<u64> {
        std::fs::metadata(&self.path).ok().map(|m| m.len())
    }
}

/// Maps a rusqlite error to [`AppError::Database`].
pub(crate) fn sql_err(e: rusqlite::Error) -> AppError {
    AppError::Database(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opening_creates_a_usable_database() {
        let db = Db::open_in_memory().expect("open");
        db.with_conn(|conn| {
            let n: i64 = conn
                .query_row("SELECT COUNT(*) FROM rejection_templates", [], |r| r.get(0))
                .map_err(sql_err)?;
            assert!(n > 0);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn a_failing_transaction_rolls_back() {
        let db = Db::open_in_memory().unwrap();
        let result: AppResult<()> = db.with_tx(|tx| {
            tx.execute(
                "INSERT INTO settings (key, value, updated_at) VALUES ('a', 'b', 'now')",
                [],
            )
            .map_err(sql_err)?;
            Err(AppError::Internal("boom".into()))
        });
        assert!(result.is_err());

        let count: i64 = db
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM settings", [], |r| r.get(0))
                    .map_err(sql_err)
            })
            .unwrap();
        assert_eq!(count, 0);
    }
}
