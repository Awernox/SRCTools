//! Speedrun.com API v1 integration.

pub mod client;
pub mod endpoints;
pub mod models;
pub mod rate_limit;

pub use client::{SrcClient, WEB_BASE};
