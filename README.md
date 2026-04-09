# Trello MCP Server

Token-optimized [Model Context Protocol](https://modelcontextprotocol.io/) server for Trello, designed for [Claude Code](https://claude.ai/claude-code).

## Why?

Standard Trello API responses are bloated with metadata Claude doesn't need. This server:

- **Requests only essential fields** from Trello API (`fields=` param)
- **Returns compact text summaries** instead of raw JSON
- **Truncates descriptions** to save context tokens
- **Caches board structure** (lists, labels) to avoid redundant API calls

Result: **60-80% fewer tokens** per Trello interaction compared to raw API.

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Get Trello credentials

1. Get your API key at https://trello.com/power-ups/admin
2. Generate a token from the same page
3. Find your board ID from the board URL: `https://trello.com/b/<BOARD_ID>/...`

### 3. Configure environment

```bash
export TRELLO_API_KEY="your-api-key"
export TRELLO_TOKEN="your-token"
export TRELLO_BOARD_ID="your-default-board-id"  # optional
```

The server also supports a local `.env` fallback when these variables are not present in the process environment. It looks for `.env` in:

1. the current working directory
2. the `trello-mcp-server/` directory

Example:

```env
TRELLO_API_KEY=your-api-key
TRELLO_TOKEN=your-token
TRELLO_BOARD_ID=your-default-board-id
```

### 4. Add to Claude Code

Add to your `~/.claude/settings.json` or project `.claude/settings.json`:

```json
{
  "mcpServers": {
    "trello": {
      "command": "bun",
      "args": ["run", "/path/to/trello-mcp-server/index.ts"],
      "env": {
        "TRELLO_API_KEY": "your-api-key",
        "TRELLO_TOKEN": "your-token",
        "TRELLO_BOARD_ID": "your-default-board-id"
      }
    }
  }
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `get_active_board_info` | Board overview: lists, labels, card counts |
| `get_lists` | All board lists with IDs |
| `get_cards_by_list_id` | Cards from a specific list |
| `get_all_cards` | All cards grouped by list (excludes Done by default) |
| `get_card` | Full card details with checklists and comments |
| `add_card_to_list` | Create a new card |
| `move_card` | Move card to a different list |
| `update_card_details` | Update card name, description, due date, labels |
| `archive_card` | Archive (soft-delete) a card |
| `add_comment` | Add a comment to a card |
| `read_comments` | Get all comments from a card with full text and metadata |
| `get_board_labels` | All labels on the board |
| `get_recent_activity` | Recent board activity |
| `manage_checklist` | Create checklists, add/toggle items |
| `search_cards` | Search cards by name, description, or label |

## Multi-board Support

All tools accept an optional `board` parameter — a board URL, shortLink, or full board ID. If omitted, `TRELLO_BOARD_ID` is used.

```
# These all work:
board: "https://trello.com/b/ABC123/my-board"
board: "ABC123"
board: "60d5ecb5a3b2c123456789ab"
```

## License

MIT
