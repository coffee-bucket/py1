const XLSX_URL = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";

const state = {
  file: null,
  rows: [],
  shippingFee: 0,
  debug: [],
};

const els = {
  file: document.querySelector("#quoteFile"),
  dropzone: document.querySelector("#dropzone"),
  extract: document.querySelector("#extractBtn"),
  clear: document.querySelector("#sampleBtn"),
  status: document.querySelector("#status"),
  resultTitle: document.querySelector("#resultTitle"),
  resultBody: document.querySelector("#resultBody"),
  copyJson: document.querySelector("#copyJson"),
  downloadCsv: document.querySelector("#downloadCsv"),
  downloadEdufine: document.querySelector("#downloadEdufine"),
  debugLog: document.querySelector("#debugLog"),
};

els.file.addEventListener("change", () => {
  const [file] = els.file.files;
  setFile(file);
});

els.dropzone.addEventListener("click", () => {
  els.file.click();
});

els.dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    els.file.click();
  }
});

["dragenter", "dragover"].forEach((eventName) => {
  els.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropzone.classList.add("is-dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  els.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropzone.classList.remove("is-dragging");
  });
});

els.dropzone.addEventListener("drop", (event) => {
  const [file] = event.dataTransfer.files;
  els.file.value = "";
  setFile(file);
});

els.extract.addEventListener("click", extractWorkbook);
els.clear.addEventListener("click", clearResults);

els.copyJson.addEventListener("click", async () => {
  await navigator.clipboard.writeText(JSON.stringify(state.rows, null, 2));
  setStatus("JSON을 클립보드에 복사했습니다.");
});

els.downloadCsv.addEventListener("click", () => {
  const csv = toCsv(state.rows);
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "quote-items.csv";
  a.click();
  URL.revokeObjectURL(url);
});

els.downloadEdufine.addEventListener("click", async () => {
  const XLSX = await loadXlsx();
  const workbook = buildEdufineWorkbook(XLSX);
  XLSX.writeFile(workbook, "품목내역(통합)_입력완료.xls", { bookType: "xls" });
  setStatus("품목내역 엑셀 파일을 저장했습니다.");
});

els.resultBody.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-row]");
  if (!button) return;

  const row = state.rows.find((item) => String(item.no) === button.dataset.copyRow);
  if (!row) return;

  await navigator.clipboard.writeText(toEdufineRow(row));
  button.textContent = "복사됨";
  setStatus(`${row.no}번 품목을 품의용 형식으로 복사했습니다.`);

  window.setTimeout(() => {
    button.textContent = "품의용 복사";
  }, 1200);
});

function setFile(file) {
  if (!file) return;
  if (!/\.(xls|xlsx)$/i.test(file.name)) {
    setStatus("엑셀 파일(.xls, .xlsx)만 업로드할 수 있습니다.", true);
    return;
  }

  state.file = file;
  els.extract.disabled = false;
  setStatus(`${file.name} 선택됨. 추출하기를 누르세요.`);
}

async function extractWorkbook() {
  if (!state.file) return;

  clearResults();
  setStatus("엑셀 파일을 읽는 중입니다...");

  try {
    const XLSX = await loadXlsx();
    const data = await state.file.arrayBuffer();
    const workbook = XLSX.read(data, { type: "array", cellDates: false });
    const allRows = [];
    let shippingFee = 0;

    log(`시트 ${workbook.SheetNames.length}개를 확인합니다.`);

    workbook.SheetNames.forEach((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: "",
        raw: false,
        blankrows: false,
      });
      const sheetRows = parseSheetRows(rows, sheetName);
      const sheetShippingFee = findShippingFee(rows);

      allRows.push(...sheetRows);
      shippingFee += sheetShippingFee;
      log(`${sheetName}: 행 ${rows.length}개, 키워드 매칭 품목 ${sheetRows.length}개, 배송비 ${formatNumber(sheetShippingFee)}원`);

      if (sheetRows.length === 0) {
        log(`읽힌 행 미리보기:\n${previewRows(rows)}`);
      }
    });

    state.rows = allRows.map((row, index) => ({ no: index + 1, ...row }));
    state.shippingFee = shippingFee;
    renderResults();
    setStatus(`완료했습니다. 품목 ${state.rows.length}개를 추출했습니다.`);
  } catch (error) {
    console.error(error);
    setStatus(`추출하지 못했습니다: ${error.message}`, true);
    log(error.stack || error.message);
  }
}

function findShippingFee(rows) {
  return rows.reduce((sum, row) => {
    const hasShippingLabel = row.some((value) => compactText(value).includes("배송비"));
    if (!hasShippingLabel) return sum;

    const numbers = row
      .map(toNumber)
      .filter((value) => Number.isFinite(value));

    if (numbers.length === 0) return sum;

    return sum + numbers[numbers.length - 1];
  }, 0);
}

async function loadXlsx() {
  if (window.XLSX) return window.XLSX;

  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = XLSX_URL;
    script.onload = resolve;
    script.onerror = () => reject(new Error("엑셀 처리 라이브러리를 불러오지 못했습니다."));
    document.head.append(script);
  });

  return window.XLSX;
}

function parseSheetRows(rows, sheetName) {
  const tableRows = parseHeaderTable(rows, sheetName);
  if (tableRows.length > 0) {
    log("엑셀 규칙: 헤더 행에서 상품명/필수선택/추가구성/수량/공급가액을 찾았습니다.");
    return tableRows;
  }

  const blockRows = parseLabelBlocks(rows, sheetName);
  if (blockRows.length > 0) {
    log("엑셀 규칙: 라벨-값 구조에서 상품명/수량/공급가액을 찾았습니다.");
    return blockRows;
  }

  return [];
}

function parseHeaderTable(rows, sheetName) {
  const headerIndex = rows.findIndex((row) => {
    return rowHas(row, "상품명") &&
      rowHas(row, "수량") &&
      rowHas(row, "공급가액");
  });

  if (headerIndex < 0) return [];

  const headers = rows[headerIndex].map(normalizeHeader);
  const columns = {
    productName: findHeaderIndex(headers, "상품명"),
    requiredOption: findHeaderIndex(headers, "필수선택"),
    addOn: findHeaderIndex(headers, "추가구성"),
    quantity: findHeaderIndex(headers, "수량"),
    supplyAmount: findHeaderIndex(headers, "공급가액"),
  };

  return rows
    .slice(headerIndex + 1)
    .map((row) => rowFromTable(row, columns, sheetName))
    .filter((row) => row.name && row.quantity && row.unitPrice);
}

function rowFromTable(row, columns, sheetName) {
  const contents = [
    cell(row, columns.productName),
    cell(row, columns.requiredOption),
    cell(row, columns.addOn),
  ].map(cleanItemText).filter(Boolean);

  const quantity = toNumber(cell(row, columns.quantity));
  const supplyAmount = toNumber(cell(row, columns.supplyAmount));
  const unitPrice = quantity && supplyAmount ? Math.round(supplyAmount / quantity) : null;

  return {
    name: contents.join(" / "),
    spec: "개",
    quantity,
    unitPrice,
    total: quantity && unitPrice ? quantity * unitPrice : null,
    source: sheetName,
  };
}

function parseLabelBlocks(rows, sheetName) {
  const blocks = [];
  let current = createBlock();
  let pendingLabel = null;

  rows.forEach((row) => {
    const values = extractValuesFromRow(row);

    if (values.productName && hasBlockData(current)) {
      blocks.push(current);
      current = createBlock();
      pendingLabel = null;
    }

    if (Object.keys(values).length > 0) {
      applyValues(current, values);
      pendingLabel = trailingLabel(row);
      return;
    }

    if (pendingLabel && row.some((value) => cleanValue(value))) {
      applyValues(current, { [pendingLabel]: firstText(row) });
      pendingLabel = null;
    }
  });

  if (hasBlockData(current)) blocks.push(current);

  return blocks
    .map((block) => blockToRow(block, sheetName))
    .filter((row) => row.name && row.quantity && row.unitPrice);
}

function extractValuesFromRow(row) {
  const values = {};

  row.forEach((value, index) => {
    const label = canonicalLabel(value);
    if (!label) return;

    const inlineValue = textAfterLabel(value);
    const nextValue = inlineValue || nextMeaningfulCell(row, index + 1);
    if (nextValue) values[label] = nextValue;
  });

  return values;
}

function applyValues(block, values) {
  if (values.productName) pushUnique(block.contents, values.productName);
  if (values.requiredOption) pushUnique(block.contents, values.requiredOption);
  if (values.addOn) pushUnique(block.contents, values.addOn);

  const quantity = toNumber(values.quantity);
  if (quantity) block.quantity = quantity;

  const supplyAmount = toNumber(values.supplyAmount);
  if (supplyAmount) block.supplyAmount = supplyAmount;
}

function blockToRow(block, sheetName) {
  const unitPrice = block.quantity && block.supplyAmount
    ? Math.round(block.supplyAmount / block.quantity)
    : null;

  return {
    name: block.contents.map(cleanItemText).filter(Boolean).join(" / "),
    spec: "개",
    quantity: block.quantity,
    unitPrice,
    total: block.quantity && unitPrice ? block.quantity * unitPrice : null,
    source: sheetName,
  };
}

function createBlock() {
  return {
    contents: [],
    quantity: null,
    supplyAmount: null,
  };
}

function hasBlockData(block) {
  return block.contents.length > 0 || block.quantity || block.supplyAmount;
}

function trailingLabel(row) {
  const lastText = [...row].reverse().find((value) => cleanValue(value));
  return canonicalLabel(lastText);
}

function canonicalLabel(value) {
  const text = compactText(value);
  if (text.includes("상품명")) return "productName";
  if (text.includes("필수선택")) return "requiredOption";
  if (text.includes("추가구성")) return "addOn";
  if (text === "수량" || text.includes("구매수량")) return "quantity";
  if (text.includes("공급가액")) return "supplyAmount";
  return null;
}

function findHeaderIndex(headers, label) {
  return headers.findIndex((header) => header.includes(compactText(label)));
}

function rowHas(row, keyword) {
  return row.some((value) => compactText(value).includes(compactText(keyword)));
}

function cell(row, index) {
  return index >= 0 ? cleanValue(row[index]) : "";
}

function firstText(row) {
  return cleanValue(row.find((value) => cleanValue(value)) || "");
}

function nextMeaningfulCell(row, startIndex) {
  for (let index = startIndex; index < row.length; index += 1) {
    const value = cleanValue(row[index]);
    if (value && !canonicalLabel(value)) return value;
    if (canonicalLabel(value)) return "";
  }
  return "";
}

function textAfterLabel(value) {
  const text = cleanValue(value);
  const match = text.match(/^(상품명|필수\s*선택|필수선택|추가\s*구성|추가구성|수량|구매\s*수량|구매수량|공급\s*가액|공급가액)\s*[:：|\-]?\s*(.+)$/);
  return match ? cleanValue(match[2]) : "";
}

function pushUnique(values, value) {
  const cleaned = cleanItemText(value);
  if (cleaned && !values.includes(cleaned)) values.push(cleaned);
}

function cleanItemText(value) {
  return cleanValue(value)
    .replace(/^(선택|없음|해당없음|무료|기본)\s*$/g, "")
    .replace(/\s*\/\s*$/g, "");
}

function cleanValue(value) {
  return normalizeText(value)
    .replace(/^[:：|\-\s]+/, "")
    .trim();
}

function normalizeHeader(value) {
  return compactText(value);
}

function previewRows(rows) {
  return rows
    .slice(0, 15)
    .map((row, index) => `${index + 1}: ${row.map(cleanValue).filter(Boolean).join(" | ")}`)
    .filter((line) => !line.endsWith(": "))
    .join("\n");
}

function renderResults() {
  els.resultTitle.textContent = `품목 ${state.rows.length}개`;
  els.copyJson.disabled = state.rows.length === 0;
  els.downloadCsv.disabled = state.rows.length === 0;
  els.downloadEdufine.disabled = state.rows.length === 0;

  if (state.rows.length === 0) {
    els.resultBody.innerHTML = `<tr class="empty-row"><td colspan="7">추출된 품목이 없습니다. 추출 로그에서 엑셀 내용을 확인해 주세요.</td></tr>`;
    return;
  }

  const itemTotalAmount = state.rows.reduce((sum, row) => sum + (row.total || 0), 0);
  const finalTotalAmount = itemTotalAmount + state.shippingFee;
  const bodyRows = state.rows.map((row) => `
    <tr>
      <td>${row.no}</td>
      <td>${escapeHtml(row.name)}</td>
      <td>${escapeHtml(row.spec)}</td>
      <td>${row.quantity ?? ""}</td>
      <td>${formatNumber(row.unitPrice)}</td>
      <td>${formatNumber(row.total)}</td>
      <td><button type="button" class="copy-row-btn" data-copy-row="${row.no}">품의용 복사</button></td>
    </tr>
  `).join("");

  els.resultBody.innerHTML = `${bodyRows}
    <tr class="summary-row">
      <td colspan="5">배송비</td>
      <td>${formatNumber(state.shippingFee)}</td>
      <td></td>
    </tr>
    <tr class="total-row">
      <td colspan="5">최종 합계</td>
      <td>${formatNumber(finalTotalAmount)}</td>
      <td></td>
    </tr>
  `;
}

function clearResults() {
  state.rows = [];
  state.shippingFee = 0;
  state.debug = [];
  els.resultTitle.textContent = "품목 0개";
  els.resultBody.innerHTML = `<tr class="empty-row"><td colspan="7">엑셀 파일을 업로드하면 품목이 여기에 표시됩니다.</td></tr>`;
  els.copyJson.disabled = true;
  els.downloadCsv.disabled = true;
  els.downloadEdufine.disabled = true;
  els.debugLog.textContent = "";
  setStatus(state.file ? `${state.file.name} 선택됨.` : "아직 선택된 엑셀 파일이 없습니다.");
}

function toEdufineRow(row) {
  return [
    row.no,
    row.name,
    row.spec,
    row.quantity ?? "",
    "",
    row.unitPrice ?? "",
    row.total ?? "",
  ].join("\t");
}

function buildEdufineWorkbook(XLSX) {
  const rows = [
    ["내용", "규격", "단위", "수량", "예상단가"],
    ...state.rows.map((row) => [
      row.name,
      row.spec,
      "",
      row.quantity ?? "",
      row.unitPrice ?? "",
    ]),
  ];

  if (state.shippingFee > 0) {
    rows.push([
      "배송비",
      "",
      "",
      1,
      state.shippingFee,
    ]);
  }

  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = [
    { wch: 42 },
    { wch: 10 },
    { wch: 8 },
    { wch: 8 },
    { wch: 14 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "품목내역");
  return workbook;
}

function toCsv(rows) {
  const header = ["순번", "내용", "규격", "수량", "예상단가", "합계"];
  const body = rows.map((row) => [
    row.no,
    row.name,
    row.spec,
    row.quantity ?? "",
    row.unitPrice ?? "",
    row.total ?? "",
  ]);
  const itemTotalAmount = rows.reduce((sum, row) => sum + (row.total || 0), 0);
  const finalTotalAmount = itemTotalAmount + state.shippingFee;

  return [header, ...body, ["", "배송비", "", "", "", state.shippingFee], ["", "최종 합계", "", "", "", finalTotalAmount]]
    .map((line) => line.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))
    .join("\n");
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function compactText(value) {
  return normalizeText(value).replace(/\s+/g, "");
}

function toNumber(value) {
  const normalized = normalizeText(value).replace(/[^\d.-]/g, "");
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function formatNumber(value) {
  return typeof value === "number" ? value.toLocaleString("ko-KR") : "";
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle("error", isError);
}

function log(message) {
  state.debug.push(message);
  els.debugLog.textContent = state.debug.join("\n");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
