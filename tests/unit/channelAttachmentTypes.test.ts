import test from "node:test";
import assert from "node:assert/strict";
import type { ChannelAttachment } from "../../src/channels/types.js";

test("every channel attachment variant uses a blob-backed payload", () => {
  const base = { blobId: "a".repeat(64), mime: "application/octet-stream", size: 1 };
  const attachments: ChannelAttachment[] = [
    { kind: "image", ...base, width: 1, height: 1 },
    { kind: "voice", ...base, durationSeconds: 1 },
    { kind: "audio", ...base, durationSeconds: 1 },
    { kind: "video", ...base, width: 1, height: 1 },
    { kind: "document", ...base, filename: "file.bin" },
    { kind: "url", ...base, url: "https://example.com" },
  ];

  assert.equal(attachments.every((attachment) => attachment.blobId === base.blobId), true);
});
