(() => {
  "use strict";

  const radar = window.RADAR;
  const byId = (id) => document.getElementById(id);
  const rowsBody = byId("rows");
  const liveBody = byId("live-rows");
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
  const codeOrder = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  const sourceRows = radar && Array.isArray(radar.rows) ? radar.rows : [];
  const liveData = radar && (Array.isArray(radar.live) ? radar.live
    : Array.isArray(radar.live_rows) ? radar.live_rows : []);
  const liveRows = Array.isArray(liveData) ? liveData : [];
  let selectedSlug = null;
  let activeView = "board";

  function compactMoney(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    const format = (amount, digits) => amount.toFixed(digits).replace(/\.?0+$/, "");
    if (Math.abs(number) >= 1e9) return `$${format(number / 1e9, 2)}B`;
    if (Math.abs(number) >= 1e6) return `$${format(number / 1e6, 1)}M`;
    if (Math.abs(number) >= 1e3) return `$${format(number / 1e3, 0)}K`;
    return `$${Math.round(number).toLocaleString("en-US")}`;
  }

  function percent(value) {
    const number = Number(value);
    if (value === null || value === undefined || !Number.isFinite(number)) return "—";
    return `${number >= 0 ? "+" : ""}${number.toFixed(1)}%`;
  }

  function ageLabel(value) {
    const days = Number(value);
    if (value === null || value === undefined || !Number.isFinite(days) || days < 0) return "—";
    if (days < 365) return `${Math.floor(days)} days`;
    const years = Math.floor(days / 365);
    const months = Math.floor((days - years * 365) / 30);
    return `${years}y ${months}m`;
  }

  function dateLabel(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
    }).format(date);
  }

  function setText(selector, value) {
    const element = document.querySelector(selector);
    if (element) element.textContent = value;
  }

  function populateSelect(select, values, allLabel) {
    select.replaceChildren(new Option(allLabel, ""));
    [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))]
      .sort((a, b) => codeOrder(a.toLowerCase(), b.toLowerCase()) || codeOrder(a, b))
      .forEach((value) => select.add(new Option(value, value)));
  }

  function statValue(name, fallback) {
    if (radar && radar[name] !== undefined) return Number(radar[name]) || 0;
    if (radar && radar.counts && radar.counts[fallback] !== undefined) {
      return Number(radar.counts[fallback]) || 0;
    }
    return fallback === "board" ? sourceRows.length
      : fallback === "live" ? liveRows.length : 0;
  }

  function fillStats() {
    const boardSize = statValue("board_size", "board");
    const watchlistSize = statValue("watchlist_size", "watchlist");
    const sortedValues = sourceRows.map((row) => Number(row.implied_value_usd))
      .filter(Number.isFinite).sort((a, b) => a - b);
    let middle = "—";
    if (sortedValues.length) {
      const index = Math.floor(sortedValues.length / 2);
      const median = sortedValues.length % 2
        ? sortedValues[index]
        : (sortedValues[index - 1] + sortedValues[index]) / 2;
      middle = compactMoney(median);
    }
    byId("stat-date").textContent = dateLabel(radar.as_of);
    byId("stat-rows").textContent = String(boardSize);
    byId("stat-watch").textContent = `${watchlistSize} / ${watchlistSize}`;
    byId("stat-median").textContent = middle;
    byId("stat-live").textContent = String(statValue("live_size", "live"));
    const date = document.querySelector(".data-date");
    if (date) {
      date.textContent = `Model ${radar.model_version || "peer-anchor-1"} · Data date: ${dateLabel(radar.as_of)}`;
    }
  }

  function chainsHtml(chains) {
    return (Array.isArray(chains) ? chains : [])
      .map((chain) => `<span class="chain-chip">${esc(chain)}</span>`).join("") || "—";
  }

  function confidenceHtml(value) {
    const grade = ["A", "B", "C"].includes(value) ? value : "C";
    return `<span class="confidence-pill confidence-${grade.toLowerCase()}">${grade}</span>`;
  }

  function currentRows() {
    const query = byId("q").value.trim().toLowerCase();
    const category = byId("f-cat").value;
    const chain = byId("f-chain").value;
    const sort = byId("f-sort").value;
    const filtered = sourceRows.filter((row) => {
      const matchesText = !query || [row.name, row.slug, row.category]
        .some((value) => String(value ?? "").toLowerCase().includes(query));
      const matchesCategory = !category || row.category === category;
      const matchesChain = !chain || (Array.isArray(row.chains) && row.chains.includes(chain));
      return matchesText && matchesCategory && matchesChain;
    });
    const fields = {
      value: "implied_value_usd",
      tvl: "tvl_usd",
      growth: "change_7d",
      age: "age_days",
    };
    const field = fields[sort] || fields.value;
    filtered.sort((a, b) => {
      const left = a[field];
      const right = b[field];
      if (left === null || left === undefined) {
        return right === null || right === undefined
          ? codeOrder(String(a.slug ?? ""), String(b.slug ?? ""))
          : 1;
      }
      if (right === null || right === undefined) return -1;
      const difference = Number(right) - Number(left);
      return Number.isFinite(difference) && difference !== 0
        ? difference
        : codeOrder(String(a.slug ?? ""), String(b.slug ?? ""));
    });
    return filtered;
  }

  function renderBoard() {
    const rows = currentRows();
    rowsBody.innerHTML = rows.map((row) => {
      const selected = row.slug === selectedSlug ? " is-selected" : "";
      return `<tr class="board-row${selected}" data-slug="${esc(row.slug)}" tabindex="0" aria-selected="${row.slug === selectedSlug}">
        <td class="rank-value">${esc(row.rank ?? "—")}</td>
        <td><span class="protocol-name">${esc(row.name)}</span><span class="protocol-slug">${esc(row.slug)}</span></td>
        <td>${esc(row.category || "Uncategorized")}</td>
        <td>${chainsHtml(row.chains)}</td>
        <td class="numeric">${compactMoney(row.tvl_usd)}</td>
        <td class="numeric ${Number(row.change_7d) > 0 ? "change-positive" : Number(row.change_7d) < 0 ? "change-negative" : ""}">${percent(row.change_7d)}</td>
        <td class="numeric">${ageLabel(row.age_days)}</td>
        <td class="numeric implied-value">${compactMoney(row.implied_value_usd)}</td>
        <td>${confidenceHtml(row.confidence)}</td>
      </tr>`;
    }).join("");
    byId("empty").hidden = rows.length !== 0;
    byId("count-line").textContent = `Showing ${rows.length} of ${sourceRows.length} protocols.`;
    rowsBody.querySelectorAll(".board-row").forEach((element) => {
      const select = () => selectRow(element.dataset.slug);
      element.addEventListener("click", select);
      element.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select();
        }
      });
    });
  }

  function capitalFor(tvl) {
    if (tvl >= 5e9) return 250;
    if (tvl >= 1e9) return 150;
    if (tvl >= 1e8) return 100;
    if (tvl >= 1e7) return 50;
    return 25;
  }

  function holdDays(age) {
    if (age === null || age === undefined || !Number.isFinite(Number(age))) return 60;
    if (age < 180) return 90;
    if (age < 365) return 60;
    if (age < 730) return 45;
    return 30;
  }

  function dollars(amount) {
    return `$${Number(amount.toFixed(2)).toString()}`;
  }

  function categoryAction(category, chain) {
    const value = String(category ?? "").trim().toLowerCase();
    if (["lending", "cdp", "collateral"].includes(value)) return `Supply USDC to the protocol on ${chain}`;
    if (["dexs", "dex", "yield", "leveraged farming", "liquidity"].includes(value)) return `Provide liquidity to the protocol's main pool on ${chain}`;
    if (["derivatives", "perps"].includes(value)) return `Deposit margin and open one small hedge on ${chain}`;
    if (["staking", "restaking", "liquid staking", "liquid restaking"].includes(value)) return `Stake the chain asset through the protocol on ${chain}`;
    if (["risk curators", "allocator", "vault"].includes(value)) return `Deposit into a protocol vault on ${chain} and keep the shares`;
    if (value === "rwa") return `Mint or hold the protocol's yield asset on ${chain}`;
    if (value === "insurance") return `Buy protocol cover on ${chain}`;
    if (["payments", "stablecoin"].includes(value)) return `Mint or deposit the protocol's stable asset on ${chain}`;
    return `Deposit USDC into the protocol on ${chain} and keep the position open`;
  }

  function makeFarmSteps(row) {
    const capital = capitalFor(Number(row.tvl_usd) || 0);
    const quarter = dollars(capital / 4);
    const chains = Array.isArray(row.chains) ? row.chains : [];
    const chain = chains[0] || "the first listed chain";
    const hold = holdDays(row.age_days);
    const action = categoryAction(row.category, chain);
    const repeat = chains[1]
      ? `Repeat the step-2 action on ${chains[1]} using ${quarter}`
      : `Add ${quarter} to the step-2 position on ${chain}`;
    return [
      "Create a fresh wallet holding only farm funds and store its seed phrase offline. Cost: under $3 of gas. Time: 5 minutes.",
      `${action}. Cost: ${dollars(capital)} capital plus a few dollars of gas. Time: 15 minutes.`,
      `${repeat}. Cost: ${quarter} capital plus a few dollars of gas. Time: 15 minutes.`,
      "Complete one qualifying deposit, borrow, swap, or vote on the protocol each week. Cost: about $2 of gas a week. Time: 10 minutes a week.",
      `Keep the position open for at least ${hold} days so activity spans several snapshots. Cost: ${dollars(capital)} capital staying in place. Time: ${hold} days.`,
      "Check the protocol's own points or rewards page, entering only from the link on its official site, and never pay anyone to claim. Cost: nothing to check. Time: 10 minutes.",
      "Keep a farm log of the wallet, dates, transactions, and costs, and set a review date to unwind or repeat. Cost: nothing. Time: 5 minutes.",
    ];
  }

  function renderDetail(row) {
    const panel = byId("detail");
    if (!row) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    setText("[data-detail-name]", row.name || row.slug || "Protocol");
    setText("[data-detail-category]", row.category || "Uncategorized");
    setText("[data-detail-chains]", (row.chains || []).join(", ") || "—");
    setText("[data-detail-tvl]", compactMoney(row.tvl_usd));
    setText("[data-detail-growth]", percent(row.change_7d));
    setText("[data-detail-age]", ageLabel(row.age_days));
    setText("[data-detail-value]", compactMoney(row.implied_value_usd));
    const badge = document.querySelector("[data-detail-confidence]");
    badge.textContent = ["A", "B", "C"].includes(row.confidence) ? row.confidence : "C";
    badge.className = `confidence-pill confidence-${badge.textContent.toLowerCase()}`;

    let breakdown = panel.querySelector(".factor-breakdown");
    if (!breakdown) {
      breakdown = document.createElement("section");
      breakdown.className = "factor-breakdown";
      const heading = document.createElement("h3");
      heading.textContent = "Value factors";
      const list = document.createElement("ul");
      breakdown.append(heading, list);
      panel.querySelector(".farm-plan").before(breakdown);
    }
    const factors = [
      ["Peer multiple", row.peer_multiple ?? row.peer, "Category token market-cap-to-TVL anchor, shrunk toward the global median."],
      ["Momentum", row.momentum, "Bounded adjustment from the protocol's 7-day TVL change."],
      ["Seasoning", row.seasoning, "Value adjustment that rises as the protocol's tracked age increases."],
      ["TVL discount", row.discount, "Mild logarithmic discount applied to very large TVL."],
      ["Chain breadth", row.breadth, "Small bonus for activity across multiple chains."],
    ];
    const list = breakdown.querySelector("ul");
    list.replaceChildren(...factors.map(([label, value, meaning]) => {
      const item = document.createElement("li");
      const number = Number(value);
      item.textContent = `${label}: ${Number.isFinite(number) ? number.toFixed(3) : "—"} — ${meaning}`;
      return item;
    }));
    const farm = panel.querySelector("[data-farm-steps]");
    farm.replaceChildren(...makeFarmSteps(row).map((text) => {
      const item = document.createElement("li");
      item.textContent = text;
      return item;
    }));
  }

  function selectRow(slug) {
    selectedSlug = slug;
    renderBoard();
    const row = sourceRows.find((candidate) => candidate.slug === slug);
    renderDetail(row);
  }

  function renderLive() {
    const liveWrap = byId("live-wrap");
    const table = liveWrap.querySelector("table");
    const note = document.createElement("p");
    note.className = "empty-state";
    note.textContent = "These protocols already trade and are shown only as peer evidence behind the multiples, never ranked.";
    liveWrap.insertBefore(note, table);
    table.querySelector("thead").innerHTML = `<tr>
      <th scope="col">Protocol</th><th scope="col">Category</th>
      <th scope="col" class="numeric">TVL</th><th scope="col" class="numeric">Market cap</th>
      <th scope="col" class="numeric">7d %</th>
    </tr>`;
    liveBody.innerHTML = liveRows.map((row) => `<tr>
      <td><span class="protocol-name">${esc(row.name)}</span><span class="protocol-slug">${esc(row.slug)}</span></td>
      <td>${esc(row.category || "Uncategorized")}</td>
      <td class="numeric">${compactMoney(row.tvl_usd)}</td>
      <td class="numeric">${compactMoney(row.mcap_usd)}</td>
      <td class="numeric ${Number(row.change_7d) > 0 ? "change-positive" : Number(row.change_7d) < 0 ? "change-negative" : ""}">${percent(row.change_7d)}</td>
    </tr>`).join("");
  }

  function switchView(view) {
    activeView = view;
    const boardView = view === "board";
    byId("view-board").classList.toggle("is-active", boardView);
    byId("view-live").classList.toggle("is-active", !boardView);
    byId("view-board").setAttribute("aria-pressed", String(boardView));
    byId("view-live").setAttribute("aria-pressed", String(!boardView));
    byId("board-table").hidden = !boardView;
    byId("empty").hidden = !boardView || currentRows().length !== 0;
    byId("detail").hidden = !boardView || !selectedSlug;
    byId("live-wrap").hidden = boardView;
    document.querySelector(".controls").hidden = !boardView;
    document.querySelector(".panel-heading h2").textContent = boardView
      ? "Pre-token protocols" : "Tokenized peer evidence";
  }

  if (!radar || !Array.isArray(radar.rows)) {
    byId("empty").hidden = false;
    byId("empty").textContent = "Radar data is unavailable.";
    return;
  }

  fillStats();
  populateSelect(byId("f-cat"), sourceRows.map((row) => row.category), "All categories");
  populateSelect(byId("f-chain"), sourceRows.flatMap((row) => row.chains || []), "All chains");
  renderLive();
  renderBoard();
  ["q", "f-cat", "f-chain", "f-sort"].forEach((id) => {
    byId(id).addEventListener(id === "q" ? "input" : "change", () => {
      renderBoard();
      if (selectedSlug && !currentRows().some((row) => row.slug === selectedSlug)) {
        selectedSlug = null;
        renderDetail(null);
      } else if (selectedSlug) {
        renderDetail(sourceRows.find((row) => row.slug === selectedSlug));
      }
    });
  });
  byId("view-board").addEventListener("click", () => switchView("board"));
  byId("view-live").addEventListener("click", () => switchView("live"));
  switchView(activeView);
})();
