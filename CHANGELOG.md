# Changelog

## [Unreleased]

### Added
- `read_comments` tool - Get all comments from a card with full text and metadata
  - Supports card ID (full or last 6 chars)
  - Configurable limit (default 50 comments)
  - Returns full comment text without truncation
  - Includes author name and timestamp for each comment
  - Multi-board support via optional `board` parameter

### Changed
- Updated README.md to include `read_comments` in tools table

## [1.0.0] - Initial Release

### Features
- Token-optimized Trello MCP server for Claude Code
- 14 tools for board, list, card, and comment management
- Multi-board support
- Caching for lists and labels (2-minute TTL)
- Compact text responses instead of raw JSON
