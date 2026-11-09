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
      const formats = includeLayout ? await readWorkbookCellFormats(readEntry) : null;
      // 서식 있는 글자(한 칸 안에서 일부만 빨간 글씨 등): 글자 조각(run)마다 글꼴을 남긴다.
      const sharedRich = includeLayout && sharedDoc
        ? [...sharedDoc.getElementsByTagNameNS(NS_MAIN, "si")].map((item) => workbookRichRuns(item, formats))
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
        const hiddenRows = [];
        const cellFills = {};
        const cellStyles = {};
        const cellRich = {};
        const rowStyles = {};
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
          const hiddenAttribute = rowNode.getAttribute("hidden");
          if (hiddenAttribute === "1" || hiddenAttribute === "true" || (Number.isFinite(height) && height > 0 && height <= 3)) hiddenRows.push(rowNumber);
          if (formats && rowNode.getAttribute("customFormat") === "1" && rowNode.hasAttribute("s")) rowStyles[rowNumber] = formats.index(Number(rowNode.getAttribute("s")));
          const row = rows[rowNumber] || [];
          for (const cell of rowNode.getElementsByTagNameNS(NS_MAIN, "c")) {
            const index = columnIndex(cell.getAttribute("r"));
            const fill = fillStyles[Number(cell.getAttribute("s") || 0)];
            if (fill) cellFills[`${rowNumber}:${index}`] = fill;
            if (formats) cellStyles[`${rowNumber}:${index}`] = formats.index(Number(cell.getAttribute("s") || 0));
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
              const inline = cell.getElementsByTagNameNS(NS_MAIN, "is")[0];
              value = [...cell.getElementsByTagNameNS(NS_MAIN, "t")].map((text) => text.textContent).join("");
              const runs = formats && inline ? workbookRichRuns(inline, formats) : null;
              if (runs) cellRich[`${rowNumber}:${index}`] = runs;
            } else {
              const valueNode = cell.getElementsByTagNameNS(NS_MAIN, "v")[0];
              value = valueNode?.textContent ?? "";
              if (type === "s" && value !== "") {
                if (sharedRich[Number(value)]) cellRich[`${rowNumber}:${index}`] = sharedRich[Number(value)];
                value = sharedStrings[Number(value)] ?? "";
              }
            }
            row[index] = value;
          }
          rows[rowNumber] = row;
        }
        const mergedRanges = [...sheet.getElementsByTagNameNS(NS_MAIN, "mergeCell")]
          .map((mergeCell) => String(mergeCell.getAttribute("ref") || ""))
          .filter(Boolean);
        const columnWidths = [];
        const columnStyles = [];
        for (const colNode of sheet.getElementsByTagNameNS(NS_MAIN, "col")) {
          const min = Number(colNode.getAttribute("min")) - 1;
          const max = Number(colNode.getAttribute("max")) - 1;
          const width = Number(colNode.getAttribute("width"));
          if (formats && colNode.hasAttribute("style") && Number.isInteger(min) && Number.isInteger(max) && max - min < 300) {
            for (let column = min; column <= max; column++) columnStyles[column] = formats.index(Number(colNode.getAttribute("style")));
          }
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
        // 화면을 원본 양식 그대로 그리기 위한 서식: 칸 서식 번호(styleTable), 시트 확대 비율, 기본 열 너비·행 높이.
        const view = sheet.getElementsByTagNameNS(NS_MAIN, "sheetView")[0];
        const formatNode = sheet.getElementsByTagNameNS(NS_MAIN, "sheetFormatPr")[0];
        const sheetFormat = formats ? {
          cellStyles, cellRich, rowStyles, columnStyles, styleTable: formats.table, baseFont: formats.baseFont,
          sheetZoom: Number(view?.getAttribute("zoomScale")) || 100,
          defaultColumnWidth: Number(formatNode?.getAttribute("defaultColWidth")) || (Number(formatNode?.getAttribute("baseColWidth")) || 8) + 0.43,
          defaultRowHeight: Number(formatNode?.getAttribute("defaultRowHeight")) || 15
        } : {};
        sheets.push({
          name: sheetNode.getAttribute("name"),
          rows,
          ...(includeLayout ? { layout: { mergedRanges, columnWidths, rowHeights, hiddenRows, cellFills, formulas, sheetPath, ...sheetFormat } } : {})
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

    // 칸 서식(cellXfs) → 화면용 서식 표. 글꼴(색·굵기·기울임·밑줄·크기·이름)·정렬·줄바꿈·테두리만 남긴다(채움색은 cellFills).
    // index(xf)는 같은 모양의 서식을 하나로 모은 번호(styleTable 위치)를 돌려준다.
    async function readWorkbookCellFormats(readEntry) {
      const bytes = await readEntry("xl/styles.xml");
      const table = [];
      const keys = new Map();
      if (!bytes) return { table, baseFont: null, color: () => "", index: () => -1 };
      const styles = parseXml(bytes, "셀 서식");
      const themeBytes = await readEntry("xl/theme/theme1.xml");
      const theme = themeBytes ? parseXml(themeBytes, "테마 색상") : null;
      const themeColors = [];
      const scheme = theme?.getElementsByTagNameNS("*", "clrScheme")[0];
      for (const color of scheme?.children || []) {
        const node = color.children[0];
        themeColors.push(node?.getAttribute("lastClr") || node?.getAttribute("val") || "");
      }
      [themeColors[0], themeColors[1]] = [themeColors[1], themeColors[0]];
      [themeColors[2], themeColors[3]] = [themeColors[3], themeColors[2]];
      const indexed = ["000000","FFFFFF","FF0000","00FF00","0000FF","FFFF00","FF00FF","00FFFF",
        "000000","FFFFFF","FF0000","00FF00","0000FF","FFFF00","FF00FF","00FFFF",
        "800000","008000","000080","808000","800080","008080","C0C0C0","808080",
        "9999FF","993366","FFFFCC","CCFFFF","660066","FF8080","0066CC","CCCCFF",
        "000080","FF00FF","FFFF00","00FFFF","800080","800000","008080","0000FF",
        "00CCFF","CCFFFF","CCFFCC","FFFF99","99CCFF","FF99CC","CC99FF","FFCC99",
        "3366FF","33CCCC","99CC00","FFCC00","FF9900","FF6600","666699","969696",
        "003366","339966","003300","333300","993300","993366","333399","333333"];
      const customIndexed = styles.getElementsByTagNameNS(NS_MAIN, "indexedColors")[0];
      if (customIndexed) [...customIndexed.children].forEach((color, index) => { indexed[index] = color.getAttribute("rgb")?.slice(-6) || indexed[index]; });
      // 글자·테두리 색: 검정(자동·시스템 전경색)은 빈 값(기본 글자색)으로 둔다.
      const color = (node) => {
        if (!node || node.getAttribute("auto") === "1") return "";
        const number = Number(node.getAttribute("indexed"));
        let rgb = node.getAttribute("rgb")?.slice(-6) ||
          (node.hasAttribute("theme") ? themeColors[Number(node.getAttribute("theme"))] : "") ||
          (node.hasAttribute("indexed") ? (number >= 64 ? "000000" : indexed[number]) : "");
        if (!/^[a-f0-9]{6}$/i.test(rgb || "")) return "";
        const tint = Number(node.getAttribute("tint") || 0);
        if (tint) rgb = rgb.match(/../g).map((part) => {
          const value = parseInt(part, 16);
          return Math.round(tint < 0 ? value * (1 + tint) : value + (255 - value) * tint).toString(16).padStart(2, "0");
        }).join("");
        rgb = rgb.toUpperCase();
        return rgb === "000000" ? "" : `#${rgb}`;
      };
      const child = (node, name) => node ? [...node.children].find((item) => item.localName === name) || null : null;
      const on = (node, name) => {
        const item = child(node, name);
        return Boolean(item) && !["0", "false"].includes(String(item.getAttribute("val") ?? "1"));
      };
      const font = (node) => {
        if (!node) return {};
        const result = {};
        const fc = color(child(node, "color"));
        if (fc) result.fc = fc;
        if (on(node, "b")) result.b = 1;
        if (on(node, "i")) result.i = 1;
        const underline = child(node, "u");
        if (underline && underline.getAttribute("val") !== "none") result.u = 1;
        if (on(node, "strike")) result.s = 1;
        const size = Number(child(node, "sz")?.getAttribute("val"));
        if (Number.isFinite(size) && size > 0) result.sz = size;
        const name = (child(node, "name") || child(node, "rFont"))?.getAttribute("val");
        if (name) result.fn = name;
        return result;
      };
      const root = styles.documentElement || styles;
      const fonts = [...(child(root, "fonts")?.children || [])].map(font);
      const borders = [...(child(root, "borders")?.children || [])].map((node) => {
        const result = {};
        for (const [side, key] of [["left", "l"], ["right", "r"], ["top", "t"], ["bottom", "b"]]) {
          const edge = child(node, side);
          const style = edge?.getAttribute("style");
          if (!style || style === "none") continue;
          result[key] = style;
          const edgeColor = color(child(edge, "color"));
          if (edgeColor) result[`${key}c`] = edgeColor;
        }
        return result;
      });
      const xfs = [...(child(root, "cellXfs")?.children || [])];
      const resolved = new Map();
      const index = (xfIndex) => {
        if (resolved.has(xfIndex)) return resolved.get(xfIndex);
        const xf = xfs[xfIndex];
        let position = -1;
        if (xf) {
          const descriptor = { ...(fonts[Number(xf.getAttribute("fontId") || 0)] || {}) };
          const border = borders[Number(xf.getAttribute("borderId") || 0)] || {};
          if (Object.keys(border).length) descriptor.bd = border;
          const alignment = child(xf, "alignment");
          const horizontal = alignment?.getAttribute("horizontal");
          if (horizontal && horizontal !== "general") descriptor.h = horizontal;
          descriptor.v = alignment?.getAttribute("vertical") || "bottom";
          if (alignment?.getAttribute("wrapText") === "1") descriptor.w = 1;
          if (alignment?.getAttribute("shrinkToFit") === "1") descriptor.sh = 1;
          const rotation = Number(alignment?.getAttribute("textRotation") || 0);
          if (rotation) descriptor.rot = rotation;
          const indent = Number(alignment?.getAttribute("indent") || 0);
          if (indent) descriptor.ind = indent;
          const key = JSON.stringify(descriptor);
          if (!keys.has(key)) { keys.set(key, table.length); table.push(descriptor); }
          position = keys.get(key);
        }
        resolved.set(xfIndex, position);
        return position;
      };
      return { table, color, index, baseFont: fonts[0] || null };
    }

    // 서식 있는 글자(<si>·<is> 안의 <r>)를 글자 조각 목록으로. 조각이 없으면 null(칸 서식으로 충분).
    function workbookRichRuns(node, formats) {
      const runs = [...node.children].filter((item) => item.localName === "r");
      if (!runs.length) return null;
      const result = runs.map((run) => {
        const text = [...run.children].filter((item) => item.localName === "t").map((item) => item.textContent).join("");
        const properties = [...run.children].find((item) => item.localName === "rPr");
        if (!properties) return { t: text, inherit: 1 };
        const style = {};
        const pick = (name) => [...properties.children].find((item) => item.localName === name) || null;
        const on = (name) => { const item = pick(name); return Boolean(item) && !["0", "false"].includes(String(item.getAttribute("val") ?? "1")); };
        const fc = formats?.color(pick("color"));
        if (fc) style.fc = fc;
        if (on("b")) style.b = 1;
        if (on("i")) style.i = 1;
        const underline = pick("u");
        if (underline && underline.getAttribute("val") !== "none") style.u = 1;
        if (on("strike")) style.s = 1;
        const size = Number(pick("sz")?.getAttribute("val"));
        if (Number.isFinite(size) && size > 0) style.sz = size;
        const name = pick("rFont")?.getAttribute("val");
        if (name) style.fn = name;
        return { t: text, ...style };
      }).filter((run) => run.t !== "");
      const plain = [...node.children].filter((item) => item.localName === "t").map((item) => item.textContent).join("");
      if (plain) result.unshift({ t: plain, inherit: 1 });
      return result.length ? result : null;
    }
