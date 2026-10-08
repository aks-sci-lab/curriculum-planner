"use strict";
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
    function normalizeZipPath(path) {
      const parts = [];
      for (const part of path.replace(/\\/g, "/").split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") parts.pop();
        else parts.push(part);
      }
      return parts.join("/");
    }

    function readZipDirectory(buffer) {
      const view = new DataView(buffer);
      const minOffset = Math.max(0, view.byteLength - 65557);
      let endOffset = -1;
      for (let offset = view.byteLength - 22; offset >= minOffset; offset--) {
        if (view.getUint32(offset, true) === 0x06054b50) { endOffset = offset; break; }
      }
      if (endOffset < 0) throw new Error("올바른 .xlsx 파일을 찾지 못했습니다.");
      const entryCount = view.getUint16(endOffset + 10, true);
      let cursor = view.getUint32(endOffset + 16, true);
      const decoder = new TextDecoder("utf-8");
      const entries = new Map();
      for (let index = 0; index < entryCount; index++) {
        if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("엑셀 압축 파일의 구조를 읽을 수 없습니다.");
        const method = view.getUint16(cursor + 10, true);
        const compressedSize = view.getUint32(cursor + 20, true);
        const nameLength = view.getUint16(cursor + 28, true);
        const extraLength = view.getUint16(cursor + 30, true);
        const commentLength = view.getUint16(cursor + 32, true);
        const localOffset = view.getUint32(cursor + 42, true);
        const name = decoder.decode(new Uint8Array(buffer, cursor + 46, nameLength));
        entries.set(name, { method, compressedSize, localOffset });
        cursor += 46 + nameLength + extraLength + commentLength;
      }
      return entries;
    }

    async function readZipEntry(buffer, directory, path) {
      const entry = directory.get(path);
      if (!entry) return null;
      const view = new DataView(buffer);
      const offset = entry.localOffset;
      if (view.getUint32(offset, true) !== 0x04034b50) throw new Error("엑셀 내부 파일을 읽을 수 없습니다.");
      const dataOffset = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
      const bytes = new Uint8Array(buffer, dataOffset, entry.compressedSize);
      if (entry.method === 0) return bytes;
      if (entry.method !== 8 || typeof DecompressionStream === "undefined") {
        throw new Error("이 브라우저에서는 엑셀 압축 해제를 지원하지 않습니다. 최신 Chrome 또는 Edge를 이용해 주세요.");
      }
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (error) {
        throw new Error("엑셀 압축 해제에 실패했습니다. 파일이 손상되지 않았는지 확인해 주세요.");
      }
    }

    function workbookWorkerMain() {
      self.onmessage = async ({ data: buffer }) => {
        try {
          const view = new DataView(buffer);
          const minOffset = Math.max(0, view.byteLength - 65557);
          let endOffset = -1;
          for (let offset = view.byteLength - 22; offset >= minOffset; offset--) {
            if (view.getUint32(offset, true) === 0x06054b50) { endOffset = offset; break; }
          }
          if (endOffset < 0) throw new Error("올바른 .xlsx 파일을 찾지 못했습니다.");
          const decoder = new TextDecoder("utf-8");
          const entries = [];
          const transfers = [];
          let cursor = view.getUint32(endOffset + 16, true);
          const entryCount = view.getUint16(endOffset + 10, true);
          for (let index = 0; index < entryCount; index++) {
            if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("엑셀 압축 파일의 구조를 읽을 수 없습니다.");
            const method = view.getUint16(cursor + 10, true);
            const compressedSize = view.getUint32(cursor + 20, true);
            const nameLength = view.getUint16(cursor + 28, true);
            const extraLength = view.getUint16(cursor + 30, true);
            const commentLength = view.getUint16(cursor + 32, true);
            const localOffset = view.getUint32(cursor + 42, true);
            const name = decoder.decode(new Uint8Array(buffer, cursor + 46, nameLength));
            cursor += 46 + nameLength + extraLength + commentLength;
            if (!/\.(?:xml|rels)$/i.test(name)) continue;
            if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("엑셀 내부 파일을 읽을 수 없습니다.");
            const dataOffset = localOffset + 30 + view.getUint16(localOffset + 26, true) +
              view.getUint16(localOffset + 28, true);
            const compressed = new Uint8Array(buffer, dataOffset, compressedSize);
            let data;
            if (method === 0) data = compressed.slice();
            else if (method === 8 && typeof DecompressionStream !== "undefined") {
              const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
              data = new Uint8Array(await new Response(stream).arrayBuffer());
            } else {
              throw new Error("이 브라우저에서는 엑셀 압축 해제를 지원하지 않습니다. 최신 Chrome 또는 Edge를 이용해 주세요.");
            }
            entries.push([name, data.buffer]);
            transfers.push(data.buffer);
          }
          self.postMessage({ entries }, transfers);
        } catch (error) {
          self.postMessage({ error: error.message || "엑셀 압축 해제에 실패했습니다." });
        }
      };
    }

    function decompressWorkbookXmlInWorker(buffer) {
      if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL.createObjectURL !== "function") {
        return Promise.resolve(null);
      }
      let worker;
      let workerUrl;
      try {
        workerUrl = URL.createObjectURL(new Blob([`(${workbookWorkerMain.toString()})()`], {
          type: "text/javascript"
        }));
        worker = new Worker(workerUrl);
      } catch (error) {
        if (workerUrl) URL.revokeObjectURL(workerUrl);
        return Promise.resolve(null);
      }
      return new Promise((resolve, reject) => {
        const finish = () => {
          worker.terminate();
          URL.revokeObjectURL(workerUrl);
        };
        worker.onmessage = ({ data }) => {
          finish();
          if (data.error) reject(new Error(data.error));
          else resolve(new Map(data.entries.map(([name, bytes]) => [name, new Uint8Array(bytes)])));
        };
        worker.onerror = (event) => {
          finish();
          event.preventDefault();
          console.warn("엑셀 Worker를 사용할 수 없어 메인 스레드에서 계속 처리합니다.");
          resolve(null);
        };
        worker.postMessage(buffer);
      });
    }

    function parseXml(bytes, label) {
      if (!bytes) return null;
      const document = new DOMParser().parseFromString(new TextDecoder("utf-8").decode(bytes), "application/xml");
      if (document.querySelector("parsererror")) throw new Error(`${label} XML을 읽을 수 없습니다.`);
      return document;
    }

    async function parseWorkbook(buffer, { expandMergedCells = false, includeLayout = false } = {}) {
      const workerEntries = await decompressWorkbookXmlInWorker(buffer);
      const directory = workerEntries ? null : readZipDirectory(buffer);
      const readEntry = (path) => workerEntries
        ? Promise.resolve(workerEntries.get(path) || null)
        : readZipEntry(buffer, directory, path);
      const workbook = parseXml(await readEntry("xl/workbook.xml"), "통합 문서");
      if (!workbook) throw new Error("엑셀 통합 문서 정보를 찾지 못했습니다.");
      const sheetNodes = [...workbook.getElementsByTagNameNS(NS_MAIN, "sheet")];
      if (!sheetNodes.length) throw new Error("엑셀 파일에 시트가 없습니다.");
      const relationships = parseXml(await readEntry("xl/_rels/workbook.xml.rels"), "시트 연결");
      if (!relationships) throw new Error("시트 연결 정보를 찾지 못했습니다.");

      const sharedBytes = await readEntry("xl/sharedStrings.xml");
      const sharedDoc = sharedBytes ? parseXml(sharedBytes, "문자열") : null;
      const sharedStrings = sharedDoc
        ? [...sharedDoc.getElementsByTagNameNS(NS_MAIN, "si")].map((item) =>
            [...item.getElementsByTagNameNS(NS_MAIN, "t")].map((text) => text.textContent).join(""))
        : [];
      const relationNodes = [...relationships.getElementsByTagNameNS(NS_PACKAGE_REL, "Relationship")];
      const fillStyles = includeLayout ? await readWorkbookFillStyles(buffer, directory, readEntry) : [];
      const sheets = [];
      for (const sheetNode of sheetNodes) {
        const relationId = sheetNode.getAttributeNS(NS_REL, "id");
        const relation = relationNodes.find((item) => item.getAttribute("Id") === relationId);
        if (!relation) throw new Error(`'${sheetNode.getAttribute("name")}' 시트 위치를 찾지 못했습니다.`);
        const target = relation.getAttribute("Target");
        const sheetPath = target.startsWith("/")
          ? normalizeZipPath(target)
          : normalizeZipPath(`xl/${target}`);
        const sheet = parseXml(await readEntry(sheetPath), sheetNode.getAttribute("name"));
        if (!sheet) throw new Error(`'${sheetNode.getAttribute("name")}' 시트를 찾지 못했습니다.`);
        const rows = [];
        const rowHeights = {};
        const cellFills = {};
        const formulas = {};
        const sharedFormulas = new Map();
        for (const cell of sheet.getElementsByTagNameNS(NS_MAIN, "c")) {
          const formula = cell.getElementsByTagNameNS(NS_MAIN, "f")[0];
          if (formula?.getAttribute("t") === "shared" && formula.textContent) {
            sharedFormulas.set(formula.getAttribute("si"), {formula:formula.textContent, ref:cell.getAttribute("r")});
          }
        }
        for (const rowNode of sheet.getElementsByTagNameNS(NS_MAIN, "row")) {
          const rowNumber = Number(rowNode.getAttribute("r")) - 1;
          const height = Number(rowNode.getAttribute("ht"));
          if (Number.isFinite(height) && height > 0) rowHeights[rowNumber] = height;
          const row = rows[rowNumber] || [];
          for (const cell of rowNode.getElementsByTagNameNS(NS_MAIN, "c")) {
            const index = columnIndex(cell.getAttribute("r"));
            const fill = fillStyles[Number(cell.getAttribute("s") || 0)];
            if (fill) cellFills[`${rowNumber}:${index}`] = fill;
            const type = cell.getAttribute("t");
            const formula = cell.getElementsByTagNameNS(NS_MAIN, "f")[0];
            if (formula && includeLayout) {
              const master = sharedFormulas.get(formula.getAttribute("si"));
              if (formula.getAttribute("t") === "shared" && !formula.textContent && master) {
                formulas[`${rowNumber}:${index}`] = shiftPlanFormula(master.formula,
                  rowNumber - (Number(master.ref.match(/\d+/)[0])-1), index-columnIndex(master.ref), null, true);
              } else formulas[`${rowNumber}:${index}`] = formula.textContent;
            }
            let value = "";
            if (type === "inlineStr") {
              value = [...cell.getElementsByTagNameNS(NS_MAIN, "t")].map((text) => text.textContent).join("");
            } else {
              const valueNode = cell.getElementsByTagNameNS(NS_MAIN, "v")[0];
              value = valueNode?.textContent ?? "";
              if (type === "s" && value !== "") value = sharedStrings[Number(value)] ?? "";
            }
            row[index] = value;
          }
          rows[rowNumber] = row;
        }
        const mergedRanges = [...sheet.getElementsByTagNameNS(NS_MAIN, "mergeCell")]
          .map((mergeCell) => String(mergeCell.getAttribute("ref") || ""))
          .filter(Boolean);
        const columnWidths = [];
        for (const colNode of sheet.getElementsByTagNameNS(NS_MAIN, "col")) {
          const min = Number(colNode.getAttribute("min")) - 1;
          const max = Number(colNode.getAttribute("max")) - 1;
          const width = Number(colNode.getAttribute("width"));
          if (!Number.isInteger(min) || !Number.isInteger(max) || !Number.isFinite(width) || width <= 0) continue;
          for (let column = min; column <= max; column++) columnWidths[column] = width;
        }
        if (expandMergedCells) {
          for (const mergedRange of mergedRanges) {
            const [startRef, endRef] = mergedRange.split(":");
            if (!startRef || !endRef) continue;
            const startColumn = columnIndex(startRef);
            const endColumn = columnIndex(endRef);
            const startRow = Number(startRef.match(/\d+/)?.[0]) - 1;
            const endRow = Number(endRef.match(/\d+/)?.[0]) - 1;
            if (![startColumn, endColumn, startRow, endRow].every(Number.isInteger)) continue;
            const value = rows[startRow]?.[startColumn] ?? "";
            for (let rowIndex = startRow; rowIndex <= endRow; rowIndex++) {
              rows[rowIndex] = rows[rowIndex] || [];
              for (let column = startColumn; column <= endColumn; column++) {
                if (rows[rowIndex][column] === undefined || rows[rowIndex][column] === "") {
                  rows[rowIndex][column] = value;
                  if (rowIndex !== startRow) {
                    rows[rowIndex]._mergedFillColumns = rows[rowIndex]._mergedFillColumns || new Set();
                    rows[rowIndex]._mergedFillColumns.add(column);
                  }
                }
              }
            }
          }
        }
        sheets.push({
          name: sheetNode.getAttribute("name"),
          rows,
          ...(includeLayout ? { layout: { mergedRanges, columnWidths, rowHeights, cellFills, formulas, sheetPath } } : {})
        });
      }
      return sheets;
    }

    async function readWorkbookFillStyles(buffer, directory, readEntry = (path) => readZipEntry(buffer, directory, path)) {
      const bytes = await readEntry("xl/styles.xml");
      if (!bytes) return [];
      const styles = parseXml(bytes, "셀 색상");
      const themeBytes = await readEntry("xl/theme/theme1.xml");
      const theme = themeBytes ? parseXml(themeBytes, "테마 색상") : null;
      const themeColors = [];
      if (theme) {
        const scheme = theme.getElementsByTagNameNS("*", "clrScheme")[0];
        for (const color of scheme?.children || []) {
          const node = color.children[0];
          themeColors.push(node?.getAttribute("lastClr") || node?.getAttribute("val") || "");
        }
        [themeColors[0], themeColors[1]] = [themeColors[1], themeColors[0]];
        [themeColors[2], themeColors[3]] = [themeColors[3], themeColors[2]];
      }
      const indexed = ["000000","FFFFFF","FF0000","00FF00","0000FF","FFFF00","FF00FF","00FFFF",
        "000000","FFFFFF","FF0000","00FF00","0000FF","FFFF00","FF00FF","00FFFF",
        "800000","008000","000080","808000","800080","008080","C0C0C0","808080",
        "9999FF","993366","FFFFCC","CCFFFF","660066","FF8080","0066CC","CCCCFF",
        "000080","FF00FF","FFFF00","00FFFF","800080","800000","008080","0000FF",
        "00CCFF","CCFFFF","CCFFCC","FFFF99","99CCFF","FF99CC","CC99FF","FFCC99",
        "3366FF","33CCCC","99CC00","FFCC00","FF9900","FF6600","666699","969696",
        "003366","339966","003300","333300","993300","993366","333399","333333"];
      const customIndexed = styles.getElementsByTagNameNS(NS_MAIN, "indexedColors")[0];
      if (customIndexed) [...customIndexed.children].forEach((color,index)=>{
        indexed[index]=color.getAttribute("rgb")?.slice(-6) || indexed[index];
      });
      const fills = [...(styles.getElementsByTagNameNS(NS_MAIN, "fills")[0]?.children || [])].map((fill) => {
        const pattern = fill.getElementsByTagNameNS(NS_MAIN, "patternFill")[0];
        if (pattern?.getAttribute("patternType") !== "solid") return "";
        const color = pattern.getElementsByTagNameNS(NS_MAIN, "fgColor")[0];
        if (!color || color.getAttribute("auto") === "1") return "";
        let rgb = color.getAttribute("rgb")?.slice(-6) ||
          (color.hasAttribute("theme") ? themeColors[Number(color.getAttribute("theme"))] : "") ||
          (color.hasAttribute("indexed") ? indexed[Number(color.getAttribute("indexed"))] : "");
        if (!/^[a-f0-9]{6}$/i.test(rgb)) return "";
        const tint = Number(color.getAttribute("tint") || 0);
        if (tint) rgb = rgb.match(/../g).map((part) => {
          const value = parseInt(part, 16);
          return Math.round(tint < 0 ? value * (1 + tint) : value + (255 - value) * tint).toString(16).padStart(2,"0");
        }).join("");
        return rgb.toUpperCase() === "FFFFFF" ? "" : `#${rgb.toUpperCase()}`;
      });
      return [...(styles.getElementsByTagNameNS(NS_MAIN, "cellXfs")[0]?.children || [])]
        .map((xf) => fills[Number(xf.getAttribute("fillId") || 0)] || "");
    }
