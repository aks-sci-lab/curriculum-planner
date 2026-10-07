const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function storedZip(entries) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, value] of entries) {
    const filename = encoder.encode(name);
    const data = encoder.encode(value);
    const local = new Uint8Array(30 + filename.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, filename.length, true);
    local.set(filename, 30);
    localParts.push(local, data);

    const central = new Uint8Array(46 + filename.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, filename.length, true);
    centralView.setUint32(42, localOffset, true);
    central.set(filename, 46);
    centralParts.push(central);
    localOffset += local.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  const parts = [...localParts, ...centralParts, end];
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of parts) {
    bytes.set(part, cursor);
    cursor += part.length;
  }
  return bytes.buffer;
}

test("workbook worker extracts XML entries off-thread and skips binary assets", async () => {
  const parser = fs.readFileSync(path.join(__dirname, "..", "xlsx-parser.js"), "utf8");
  const start = parser.indexOf("function workbookWorkerMain()");
  const end = parser.indexOf("function decompressWorkbookXmlInWorker(", start);
  assert.ok(start >= 0 && end > start, "workbook worker should be defined");
  let handler;
  let result;
  const context = vm.createContext({
    self: {
      postMessage(message, transfer) { result = { message, transfer }; },
    },
    DataView,
    TextDecoder,
    Uint8Array,
    Blob,
    Response,
    DecompressionStream,
  });
  vm.runInContext(`${parser.slice(start, end)}; workbookWorkerMain();`, context);
  handler = vm.runInContext("self.onmessage", context);
  const buffer = storedZip([
    ["xl/workbook.xml", "<workbook/>"],
    ["xl/_rels/workbook.xml.rels", "<Relationships/>"],
    ["xl/worksheets/sheet1.xml", "<worksheet/>"],
    ["xl/media/image1.png", "not XML"],
  ]);
  await handler({ data: buffer });

  assert.ok(result, "worker should reply to its message");
  assert.equal(result.message.error, undefined, result.message.error);
  assert.deepEqual(Array.from(result.message.entries, ([name]) => name), [
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
    "xl/worksheets/sheet1.xml",
  ]);
  assert.deepEqual(Array.from(result.message.entries, ([, bytes]) => new TextDecoder().decode(bytes)), [
    "<workbook/>",
    "<Relationships/>",
    "<worksheet/>",
  ]);
  assert.equal(result.transfer.length, 3);
});
