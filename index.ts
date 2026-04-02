#!/usr/bin/env bun
/**
 * Optimized Trello MCP Server for Claude Code.
 *
 * Key optimizations:
 *  - Requests only essential fields from Trello API (fields= param)
 *  - Returns compact text summaries instead of raw JSON
 *  - Truncates card descriptions to save context tokens
 *  - Caches board structure (lists, labels) to avoid redundant calls
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Config ──────────────────────────────────────────────────────────
const API_KEY = process.env.TRELLO_API_KEY ?? "";
const TOKEN = process.env.TRELLO_TOKEN ?? "";
const BOARD_ID = process.env.TRELLO_BOARD_ID ?? "";
const BASE = "https://api.trello.com/1";
const DESC_MAX = 300;

if (!API_KEY || !TOKEN) {
  console.error("TRELLO_API_KEY and TRELLO_TOKEN are required");
  process.exit(1);
}

// ── HTTP helper ─────────────────────────────────────────────────────
async function trello<T = unknown>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${BASE}${path}${sep}key=${API_KEY}&token=${TOKEN}`;
  const init: RequestInit = {
    method,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
  };
  if (body && method !== "GET") init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "unknown");
    throw new Error(`Trello ${method} ${path} -> ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── Types (minimal) ─────────────────────────────────────────────────
interface TList { id: string; name: string; pos: number }
interface TListDetails extends TList { idBoard?: string }
interface TLabel { id: string; name: string; color: string }
interface TBoardRef { id: string; name?: string; shortLink?: string }
interface TCard {
  id: string; name: string; idList: string; idBoard?: string; labels: TLabel[];
  due: string | null; dueComplete: boolean; desc: string;
  shortUrl: string; closed: boolean; pos: number; idMembers: string[];
}
interface TComment {
  id: string; data: { text: string }; date: string;
  memberCreator?: { fullName: string };
}
interface TChecklist {
  id: string; name: string;
  checkItems: { id: string; name: string; state: string }[];
}
interface TAction {
  id: string; type: string; date: string;
  data: { text?: string; card?: { name: string; id: string }; list?: { name: string }; listAfter?: { name: string }; listBefore?: { name: string } };
  memberCreator?: { fullName: string };
}

type BoardInput = { kind: "id" | "shortLink"; value: string };
type CacheEntry<T> = { data: T; time: number };

// ── Cache ───────────────────────────────────────────────────────────
const listsCache = new Map<string, CacheEntry<TList[]>>();
const labelsCache = new Map<string, CacheEntry<TLabel[]>>();
const CACHE_TTL = 120_000;

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time >= CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached<T>(cache: Map<string, CacheEntry<T>>, key: string, data: T): T {
  cache.set(key, { data, time: Date.now() });
  return data;
}

async function getLists(boardId: string): Promise<TList[]> {
  const cached = getCached(listsCache, boardId);
  if (cached) return cached;
  const lists = await trello<TList[]>("GET", `/boards/${boardId}/lists?fields=id,name,pos`);
  return setCached(listsCache, boardId, lists);
}

async function getLabels(boardId: string): Promise<TLabel[]> {
  const cached = getCached(labelsCache, boardId);
  if (cached) return cached;
  const labels = await trello<TLabel[]>("GET", `/boards/${boardId}/labels?fields=id,name,color`);
  return setCached(labelsCache, boardId, labels);
}

function invalidateCache(boardId?: string) {
  if (!boardId) {
    listsCache.clear();
    labelsCache.clear();
    return;
  }
  listsCache.delete(boardId);
  labelsCache.delete(boardId);
}

// ── Board resolution ────────────────────────────────────────────────
function parseBoardInput(input: string): BoardInput {
  const value = input.trim();
  if (!value) throw new Error("Invalid Trello board reference. Expected board URL, shortLink, or full board ID.");

  const boardUrlMatch = value.match(/^(?:https?:\/\/)?(?:www\.)?trello\.com\/b\/([A-Za-z0-9]+)(?:[/?#]|$)/i)
    ?? value.match(/^\/?b\/([A-Za-z0-9]+)(?:[/?#]|$)/i);
  if (boardUrlMatch?.[1]) return { kind: "shortLink", value: boardUrlMatch[1] };

  if (/^[a-f0-9]{24}$/i.test(value)) return { kind: "id", value };
  if (/^[A-Za-z0-9]{8,}$/.test(value)) return { kind: "shortLink", value };

  if (/^(?:https?:\/\/)?(?:www\.)?trello\.com\//i.test(value) || value.startsWith("/")) {
    throw new Error("Invalid Trello board URL. Expected a board URL like https://trello.com/b/<shortLink>/<name>.");
  }

  throw new Error("Invalid Trello board reference. Expected board URL, shortLink, or full board ID.");
}

async function resolveShortLinkToBoardId(shortLink: string): Promise<string> {
  const board = await trello<TBoardRef>("GET", `/boards/${shortLink}?fields=id,name,shortLink`);
  return board.id;
}

async function resolveBoardId(board?: string): Promise<string> {
  if (!board) {
    if (!BOARD_ID) throw new Error("TRELLO_BOARD_ID not set and no board parameter provided");
    return BOARD_ID;
  }

  const parsed = parseBoardInput(board);
  if (parsed.kind === "id") return parsed.value;
  return resolveShortLinkToBoardId(parsed.value);
}

async function assertListInBoard(listId: string, boardId: string): Promise<TList> {
  const lists = await getLists(boardId);
  const list = lists.find((item) => item.id === listId);
  if (!list) throw new Error(`List ${listId} does not belong to board ${boardId}`);
  return list;
}

async function getListDetails(listId: string): Promise<TListDetails> {
  return trello<TListDetails>("GET", `/lists/${listId}?fields=id,name,pos,idBoard`);
}

// ── Formatters ──────────────────────────────────────────────────────
function truncate(s: string, max: number): string {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max) + "...";
}

function fmtLabels(labels: TLabel[]): string {
  if (!labels.length) return "";
  return labels.map((l) => l.name || l.color).join(", ");
}

function fmtCard(card: TCard, listName: string): string {
  const labels = fmtLabels(card.labels);
  const due = card.due ? ` | due: ${card.due.slice(0, 10)}${card.dueComplete ? " DONE" : ""}` : "";
  const desc = card.desc ? `\n   ${truncate(card.desc.replace(/\n/g, " "), DESC_MAX)}` : "";
  return `[${card.id.slice(-6)}] ${card.name}${labels ? ` (${labels})` : ""}${due}\n   list: ${listName} | url: ${card.shortUrl}${desc}`;
}

function fmtCardCompact(card: TCard, listName: string): string {
  const labels = fmtLabels(card.labels);
  const due = card.due ? ` due:${card.due.slice(0, 10)}` : "";
  return `${card.id.slice(-6)} | ${listName} | ${card.name}${labels ? ` [${labels}]` : ""}${due}`;
}

const CARD_FIELDS = "id,name,idList,idBoard,labels,due,dueComplete,desc,shortUrl,closed,pos,idMembers";
const BOARD_ARG = z.string().optional().describe("Board URL, shortLink, or full board ID");

// ── MCP Server ──────────────────────────────────────────────────────
const server = new McpServer({ name: "trello", version: "1.0.0" });

// ── get_active_board_info ───────────────────────────────────────────
server.tool(
  "get_active_board_info",
  "Get board overview: lists, labels, card counts per list. Compact summary.",
  { board: BOARD_ARG },
  async ({ board }) => {
    const boardId = await resolveBoardId(board);
    const [lists, labels, cards] = await Promise.all([
      getLists(boardId),
      getLabels(boardId),
      trello<TCard[]>("GET", `/boards/${boardId}/cards?fields=id,idList,closed`),
    ]);
    const active = cards.filter((c) => !c.closed);
    const countByList = new Map<string, number>();
    for (const c of active) countByList.set(c.idList, (countByList.get(c.idList) ?? 0) + 1);

    const listLines = lists.sort((a, b) => a.pos - b.pos)
      .map((l) => `  ${l.name} (${l.id}) — ${countByList.get(l.id) ?? 0} cards`);
    const labelLines = labels.filter((l) => l.name)
      .map((l) => `  ${l.name} [${l.color}] (${l.id})`);

    const text = [
      `Board: ${boardId}`, `Cards: ${active.length} active, ${cards.length - active.length} archived`,
      "", "Lists:", ...listLines, "", "Labels:", ...labelLines,
    ].join("\n");
    return { content: [{ type: "text" as const, text }] };
  },
);

// ── get_lists ───────────────────────────────────────────────────────
server.tool(
  "get_lists",
  "Get all board lists with IDs.",
  { board: BOARD_ARG },
  async ({ board }) => {
    const lists = await getLists(await resolveBoardId(board));
    const text = lists.sort((a, b) => a.pos - b.pos).map((l) => `${l.id} | ${l.name}`).join("\n");
    return { content: [{ type: "text" as const, text: `Lists:\n${text}` }] };
  },
);

// ── get_cards_by_list_id ────────────────────────────────────────────
server.tool(
  "get_cards_by_list_id",
  "Get cards from a specific list. Returns compact card summaries.",
  {
    listId: z.string().describe("Trello list ID"),
    board: BOARD_ARG,
  },
  async ({ listId, board }) => {
    const boardId = await resolveBoardId(board);
    const list = await assertListInBoard(listId, boardId);
    const cards = await trello<TCard[]>("GET", `/lists/${listId}/cards?fields=${CARD_FIELDS}`);
    const active = cards.filter((c) => !c.closed);
    if (!active.length) return { content: [{ type: "text" as const, text: `No active cards in "${list.name}"` }] };
    const text = active.sort((a, b) => a.pos - b.pos).map((c) => fmtCard(c, list.name)).join("\n\n");
    return { content: [{ type: "text" as const, text: `${list.name} (${active.length} cards):\n\n${text}` }] };
  },
);

// ── get_all_cards ───────────────────────────────────────────────────
server.tool(
  "get_all_cards",
  "Get board cards grouped by list. Compact one-line-per-card. By default excludes Done list (89+ cards) to save context — pass exclude_done=false to include.",
  {
    include_archived: z.boolean().optional().default(false).describe("Include archived cards"),
    exclude_done: z.boolean().optional().default(true).describe("Exclude Done list to save context (default: true)"),
    board: BOARD_ARG,
  },
  async ({ include_archived, exclude_done, board }) => {
    const boardId = await resolveBoardId(board);
    const [cards, lists] = await Promise.all([
      trello<TCard[]>("GET", `/boards/${boardId}/cards?fields=${CARD_FIELDS}`),
      getLists(boardId),
    ]);
    const doneListIds = new Set(
      exclude_done ? lists.filter((l) => l.name.toLowerCase() === "done").map((l) => l.id) : [],
    );
    const filtered = cards.filter((c) => {
      if (!include_archived && c.closed) return false;
      if (doneListIds.has(c.idList)) return false;
      return true;
    });
    const groups = new Map<string, TCard[]>();
    for (const c of filtered) {
      const arr = groups.get(c.idList) ?? [];
      arr.push(c);
      groups.set(c.idList, arr);
    }
    const sections: string[] = [];
    for (const list of lists.sort((a, b) => a.pos - b.pos)) {
      const listCards = groups.get(list.id);
      if (!listCards?.length) continue;
      const lines = listCards.sort((a, b) => a.pos - b.pos).map((c) => `  ${fmtCardCompact(c, list.name)}`);
      sections.push(`--- ${list.name} (${listCards.length}) ---\n${lines.join("\n")}`);
    }
    const doneCount = doneListIds.size ? cards.filter((c) => doneListIds.has(c.idList) && !c.closed).length : 0;
    const footer = doneCount ? `\n\n(${doneCount} cards in Done — hidden, pass exclude_done=false to show)` : "";
    return { content: [{ type: "text" as const, text: (sections.join("\n\n") || "No cards found") + footer }] };
  },
);

// ── get_card ────────────────────────────────────────────────────────
server.tool(
  "get_card",
  "Get full details of a single card including description, checklists, comments. Use card ID (full or last 6 chars).",
  {
    cardId: z.string().describe("Card ID (full or suffix)"),
    board: BOARD_ARG,
  },
  async ({ cardId, board }) => {
    const boardId = await resolveBoardId(board);
    let fullId = cardId;
    if (cardId.length < 24) {
      const cards = await trello<TCard[]>("GET", `/boards/${boardId}/cards?fields=id`);
      const match = cards.find((c) => c.id.endsWith(cardId));
      if (!match) return { content: [{ type: "text" as const, text: `Card not found: ${cardId}` }] };
      fullId = match.id;
    }
    const [card, checklists, comments] = await Promise.all([
      trello<TCard>("GET", `/cards/${fullId}?fields=${CARD_FIELDS}`),
      trello<TChecklist[]>("GET", `/cards/${fullId}/checklists`),
      trello<TComment[]>("GET", `/cards/${fullId}/actions?filter=commentCard&limit=10`),
    ]);
    if (board && card.idBoard && card.idBoard !== boardId) {
      throw new Error(`Card ${card.id} does not belong to board ${boardId}`);
    }
    const lists = card.idBoard ? await getLists(card.idBoard) : await getLists(boardId);
    const listName = lists.find((l) => l.id === card.idList)?.name ?? "Unknown";

    const parts: string[] = [
      `Card: ${card.name}`, `ID: ${card.id}`, `List: ${listName}`,
      `Labels: ${fmtLabels(card.labels) || "none"}`, `URL: ${card.shortUrl}`,
      card.due ? `Due: ${card.due.slice(0, 10)}${card.dueComplete ? " (complete)" : ""}` : "",
      card.closed ? "Status: ARCHIVED" : "",
      "", "Description:", card.desc || "(empty)",
    ].filter(Boolean);

    if (checklists.length) {
      parts.push("");
      for (const cl of checklists) {
        const done = cl.checkItems.filter((i) => i.state === "complete").length;
        parts.push(`Checklist: ${cl.name} (${done}/${cl.checkItems.length})`);
        for (const item of cl.checkItems) parts.push(`  [${item.state === "complete" ? "x" : " "}] ${item.name}`);
      }
    }
    if (comments.length) {
      parts.push("", "Recent comments:");
      for (const c of comments) {
        parts.push(`  ${c.date.slice(0, 10)} ${c.memberCreator?.fullName ?? "?"}: ${truncate(c.data.text ?? "", 200)}`);
      }
    }
    return { content: [{ type: "text" as const, text: parts.join("\n") }] };
  },
);

// ── add_card_to_list ────────────────────────────────────────────────
server.tool(
  "add_card_to_list", "Create a new card on a list.",
  {
    listId: z.string().describe("Target list ID"),
    name: z.string().describe("Card title"),
    desc: z.string().optional().describe("Card description"),
    labelIds: z.string().optional().describe("Comma-separated label IDs"),
    due: z.string().optional().describe("Due date (YYYY-MM-DD)"),
    board: BOARD_ARG,
  },
  async ({ listId, name, desc, labelIds, due, board }) => {
    const boardId = await resolveBoardId(board);
    await assertListInBoard(listId, boardId);
    const body: Record<string, unknown> = { name, idList: listId, pos: "bottom" };
    if (desc) body.desc = desc;
    if (labelIds) body.idLabels = labelIds;
    if (due) body.due = due;
    const card = await trello<TCard>("POST", "/cards", body);
    invalidateCache(boardId);
    return { content: [{ type: "text" as const, text: `Created card: ${card.name}\nID: ${card.id}\nURL: ${card.shortUrl}` }] };
  },
);

// ── move_card ───────────────────────────────────────────────────────
server.tool(
  "move_card", "Move a card to a different list.",
  { cardId: z.string().describe("Card ID"), listId: z.string().describe("Target list ID") },
  async ({ cardId, listId }) => {
    await trello("PUT", `/cards/${cardId}`, { idList: listId });
    const list = await getListDetails(listId).catch(() => null);
    invalidateCache(list?.idBoard);
    const listName = list?.name ?? listId;
    return { content: [{ type: "text" as const, text: `Moved card ${cardId.slice(-6)} -> ${listName}` }] };
  },
);

// ── update_card_details ─────────────────────────────────────────────
server.tool(
  "update_card_details", "Update card name, description, due date, or labels.",
  {
    cardId: z.string().describe("Card ID"),
    name: z.string().optional().describe("New card title"),
    desc: z.string().optional().describe("New description"),
    due: z.string().optional().describe("Due date (YYYY-MM-DD or empty to remove)"),
    labelIds: z.string().optional().describe("Comma-separated label IDs (replaces all)"),
  },
  async ({ cardId, name, desc, due, labelIds }) => {
    const body: Record<string, unknown> = {};
    if (name !== undefined) body.name = name;
    if (desc !== undefined) body.desc = desc;
    if (due !== undefined) body.due = due || null;
    if (labelIds !== undefined) body.idLabels = labelIds;
    await trello("PUT", `/cards/${cardId}`, body);
    invalidateCache();
    return { content: [{ type: "text" as const, text: `Updated card ${cardId.slice(-6)}` }] };
  },
);

// ── archive_card ────────────────────────────────────────────────────
server.tool(
  "archive_card", "Archive (soft-delete) a card.",
  { cardId: z.string().describe("Card ID") },
  async ({ cardId }) => {
    await trello("PUT", `/cards/${cardId}`, { closed: true });
    invalidateCache();
    return { content: [{ type: "text" as const, text: `Archived card ${cardId.slice(-6)}` }] };
  },
);

// ── add_comment ─────────────────────────────────────────────────────
server.tool(
  "add_comment", "Add a comment to a card.",
  { cardId: z.string().describe("Card ID"), text: z.string().describe("Comment text") },
  async ({ cardId, text }) => {
    await trello("POST", `/cards/${cardId}/actions/comments`, { text });
    return { content: [{ type: "text" as const, text: `Comment added to ${cardId.slice(-6)}` }] };
  },
);

// ── get_board_labels ────────────────────────────────────────────────
server.tool(
  "get_board_labels",
  "Get all labels defined on the board.",
  { board: BOARD_ARG },
  async ({ board }) => {
    const labels = await getLabels(await resolveBoardId(board));
    const text = labels.filter((l) => l.name).map((l) => `${l.id} | ${l.name} [${l.color}]`).join("\n");
    return { content: [{ type: "text" as const, text: `Labels:\n${text}` }] };
  },
);

// ── get_recent_activity ─────────────────────────────────────────────
server.tool(
  "get_recent_activity", "Get recent board activity (last N actions). Compact summary.",
  {
    limit: z.number().optional().default(15).describe("Max actions (default 15)"),
    board: BOARD_ARG,
  },
  async ({ limit, board }) => {
    const boardId = await resolveBoardId(board);
    const actions = await trello<TAction[]>("GET", `/boards/${boardId}/actions?limit=${limit}&fields=id,type,date,data,memberCreator`);
    const ACTION_LABELS: Record<string, string> = {
      addMemberToCard: "assigned to",
      removeMemberFromCard: "unassigned from",
      addChecklistToCard: "added checklist to",
      removeChecklistFromCard: "removed checklist from",
      updateCheckItemStateOnCard: "toggled checklist item on",
      addAttachmentToCard: "attached file to",
      deleteAttachmentFromCard: "removed attachment from",
      addLabelToCard: "labeled",
      removeLabelFromCard: "unlabeled",
      copyCard: "copied",
      deleteCard: "deleted",
    };
    const lines = actions.map((a) => {
      const who = a.memberCreator?.fullName ?? "?";
      const when = a.date.slice(0, 16).replace("T", " ");
      const card = a.data.card?.name ?? "";
      let action = a.type;
      if (a.type === "commentCard") action = `commented on "${card}": ${truncate(a.data.text ?? "", 80)}`;
      else if (a.type === "updateCard" && a.data.listAfter)
        action = `moved "${card}" ${a.data.listBefore?.name ?? "?"} -> ${a.data.listAfter.name}`;
      else if (a.type === "createCard") action = `created "${card}"`;
      else if (ACTION_LABELS[a.type]) action = `${ACTION_LABELS[a.type]} "${card}"`;
      else if (card) action = `${a.type} "${card}"`;
      return `${when} | ${who} | ${action}`;
    });
    return { content: [{ type: "text" as const, text: `Recent activity:\n${lines.join("\n")}` }] };
  },
);

// ── manage_checklist ────────────────────────────────────────────────
server.tool(
  "manage_checklist", "Create checklist, add items, or toggle item state on a card.",
  {
    cardId: z.string().describe("Card ID"),
    action: z.enum(["create_checklist", "add_item", "toggle_item"]).describe("Action type"),
    checklistName: z.string().optional().describe("Checklist name (for create)"),
    checklistId: z.string().optional().describe("Checklist ID (for add_item)"),
    itemName: z.string().optional().describe("Item name (for add_item)"),
    checkItemId: z.string().optional().describe("Item ID (for toggle_item)"),
    state: z.enum(["complete", "incomplete"]).optional().describe("State (for toggle_item)"),
  },
  async ({ cardId, action, checklistName, checklistId, itemName, checkItemId, state }) => {
    if (action === "create_checklist") {
      if (!checklistName) return { content: [{ type: "text" as const, text: "checklistName required" }] };
      const cl = await trello<{ id: string; name: string }>("POST", `/cards/${cardId}/checklists`, { name: checklistName });
      return { content: [{ type: "text" as const, text: `Checklist "${cl.name}" created (${cl.id})` }] };
    }
    if (action === "add_item") {
      if (!checklistId || !itemName) return { content: [{ type: "text" as const, text: "checklistId and itemName required" }] };
      const item = await trello<{ id: string; name: string }>("POST", `/checklists/${checklistId}/checkItems`, { name: itemName });
      return { content: [{ type: "text" as const, text: `Item "${item.name}" added (${item.id})` }] };
    }
    if (action === "toggle_item") {
      if (!checkItemId || !state) return { content: [{ type: "text" as const, text: "checkItemId and state required" }] };
      await trello("PUT", `/cards/${cardId}/checkItem/${checkItemId}`, { state });
      return { content: [{ type: "text" as const, text: `Item ${checkItemId} -> ${state}` }] };
    }
    return { content: [{ type: "text" as const, text: "Unknown action" }] };
  },
);

// ── search_cards ────────────────────────────────────────────────────
server.tool(
  "search_cards", "Search cards by name, description, or label text. Returns compact matches.",
  {
    query: z.string().describe("Search text (case-insensitive)"),
    include_done: z.boolean().optional().default(false).describe("Include cards in Done list"),
    board: BOARD_ARG,
  },
  async ({ query, include_done, board }) => {
    const boardId = await resolveBoardId(board);
    const [cards, lists] = await Promise.all([
      trello<TCard[]>("GET", `/boards/${boardId}/cards?fields=${CARD_FIELDS}`),
      getLists(boardId),
    ]);
    const listMap = new Map(lists.map((l) => [l.id, l.name]));
    const doneListIds = new Set(
      include_done ? [] : lists.filter((l) => l.name.toLowerCase() === "done").map((l) => l.id),
    );
    const q = query.toLowerCase();
    const matches = cards
      .filter((c) => {
        if (c.closed) return false;
        if (doneListIds.has(c.idList)) return false;
        return (
          c.name.toLowerCase().includes(q) ||
          c.desc.toLowerCase().includes(q) ||
          c.labels.some((l) => (l.name || l.color).toLowerCase().includes(q))
        );
      })
      .slice(0, 25);
    if (!matches.length) return { content: [{ type: "text" as const, text: `No cards match "${query}"` }] };
    const lines = matches.map((c) => fmtCardCompact(c, listMap.get(c.idList) ?? "?"));
    return { content: [{ type: "text" as const, text: `Found ${matches.length} cards:\n${lines.join("\n")}` }] };
  },
);

// ── Start ───────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
