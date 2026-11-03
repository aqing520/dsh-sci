window.__ModuleLoader__.load({
	id: "dsh-sci-brand",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const { jsx, jsxs } = require("react/jsx-runtime");

		const CODEX_STYLE_ID = "dsh-sci-codex-theme";
		const RESEARCH_TITLES = {
			research_begin: "研究问题", research_context: "研究进度", research_search: "查找文献",
			research_read: "阅读正文", research_cite: "原文引用", research_claim: "研究主张",
			research_evidence: "证据关系", research_hypothesis: "可检验假设", research_design: "实验设计",
			research_code: "代码与输入", research_experiment: "实验提案", research_execute: "实验结果",
			research_approve_design: "设计审批", research_budget: "研究额度", research_analyze: "结果分析",
			research_report: "研究报告", research_artifact: "保存产物", research_inspect: "查看研究记录",
			research_memory: "研究记忆", research_checkpoint: "保存进度", research_action: "研究操作"
		};
		const evidenceId = (id) => typeof id === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(id) ? `dsh-sci-evidence-${id}` : undefined;
		function revealEvidence(id) {
			const element = typeof document === "undefined" ? undefined : document.getElementById(id);
			if (!element) return false;
			for (let parent = element; parent; parent = parent.parentElement) if (parent.tagName === "DETAILS") parent.open = true;
			element.scrollIntoView({ behavior: "smooth", block: "center" });
			element.focus?.({ preventScroll: true });
			return true;
		}
		function EvidenceRef({ id }) {
			const target = evidenceId(id);
			return target ? jsx("a", { href: `#${target}`, onClick: (event) => { event.preventDefault(); revealEvidence(target); }, children: id }) : jsx("span", { children: String(id) });
		}
		function savedText(label, text, id) {
			return jsxs("section", { id: evidenceId(id), tabIndex: -1, className: "dsh-sci-evidence-section", children: [jsx("div", { className: "dsh-sci-evidence-label", children: label }), jsx("pre", { children: String(text ?? "") })] }, id ?? label);
		}
		function ResearchToolView({ toolName, block, phase, inspect }) {
			let value;
			const raw = (block.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
			try { value = JSON.parse(raw); } catch { /* Errors and older text-only receipts remain readable. */ }
			const title = RESEARCH_TITLES[toolName] ?? toolName;
			const rows = [];
			if (value && typeof value === "object") {
				if (value.content?.contentVersionId) rows.push(savedText("保存的正文版本 · 阅读部分不等于读完整篇", `${value.content.sourceId}\n${value.content.contentVersionId}\nSHA-256: ${value.content.contentHash}\n范围：${value.content.scope ?? "unknown"}${value.content.truncated ? "（提取结果截断）" : ""}`, value.content.contentVersionId));
				for (const chunk of value.chunks ?? []) rows.push(savedText(`正文片段 ${chunk.chunkId}${chunk.page ? ` · 第 ${chunk.page} 页` : ""}`, chunk.text, chunk.chunkId));
				if (value.nextOffset !== undefined && value.nextOffset !== null) rows.push(jsx("p", { children: `仍有后续内容，下一片段偏移：${value.nextOffset}` }, "next"));
				if (value.quotedText !== undefined) {
					rows.push(savedText(`原文引句 · ${value.verification?.status === "verbatim-match" ? "已匹配保存正文；支持关系仍需判断" : "请检查核验状态"}`, value.quotedText, value.citationId));
					if (value.locator?.chunkId) rows.push(jsxs("p", { children: ["定位到正文：", jsx(EvidenceRef, { id: value.locator.chunkId })] }, "locator"));
					rows.push(savedText("来源与版本", `${value.sourceId}\n${value.contentVersionId ?? ""}`));
				}
				if (value.claimId && value.text) rows.push(savedText(`主张 · ${value.claimType ?? "未分类"} · ${value.confidence ?? "未评级"}`, value.text, value.claimId));
				for (const id of value.citationIds ?? []) rows.push(jsx(EvidenceRef, { id }, id));
				if (value.relation) rows.push(savedText(`证据关系 · ${{ supports: "支持", refutes: "反驳", qualifies: "限定", context: "背景" }[value.relation] ?? value.relation}`, value.rationale, value.evidenceId));
				for (const id of [value.citationId && !value.quotedText ? value.citationId : undefined, value.experimentRef, value.artifactRef].filter(Boolean)) rows.push(jsx(EvidenceRef, { id }, id));
				if (toolName === "research_checkpoint") rows.push(savedText("进度摘要 · 不等于科学结论验收", value.checkpoint?.summary ?? value.summary, value.checkpoint?.checkpointId));
				const run = value.run ?? (value.runId ? value : undefined);
				if (run) {
					rows.push(savedText(`运行记录 · ${run.state ?? "已保存"}${value.reused ? " · 复用已有结果，未重跑" : ""}`, JSON.stringify(run, null, 2), run.runId));
				}
				if (value.summary && toolName !== "research_checkpoint") rows.push(savedText("摘要", value.summary, value.evaluationId));
				if (value.artifactId) rows.push(savedText("产物与哈希", JSON.stringify(value, null, 2), value.artifactId));
			}
			return jsxs("details", { className: `dsh-sci-evidence-card${block.isError ? " dsh-sci-evidence-error" : ""}`, children: [
				jsx("summary", { children: `${title} · ${phase === "result" ? block.isError ? "失败" : "已记录" : "处理中"}` }, "heading"),
				...rows,
				jsxs("details", { children: [jsx("summary", { children: "完整记录" }), jsx("pre", { children: value ? JSON.stringify(value, null, 2) : raw || "正在等待工具结果。" })] }, "raw"),
				inspect ? jsx("button", { type: "button", onClick: inspect, children: "查看调用过程" }, "inspect") : null
			] });
		}

		const CODEX_THEME_TOKENS = {
			"--dsw-alias-bg-base": { light: "#ffffff", dark: "#161920" },
			"--dsw-alias-bg-layer-1": { light: "#ffffff", dark: "#1c2029" },
			"--dsw-alias-bg-layer-2": { light: "#f8fafc", dark: "#222733" },
			"--dsw-alias-bg-layer-3": { light: "#f1f5f9", dark: "#282e3c" },
			"--dsw-alias-bg-module-platform": { light: "#f3f5f8", dark: "#232834" },
			"--dsw-alias-bg-overlay": { light: "#eef2f6", dark: "#262b38" },
			"--dsw-specific-sidebar-fill": { light: "#f6f8fa", dark: "#111318" },
			"--dsw-specific-sidebar-nav-item-hover": { light: "#eaeef4", dark: "#1d212a" },
			"--dsw-specific-sidebar-nav-item-active": { light: "#e2e8f0", dark: "#262b36" },
			"--dsw-specific-sidebar-nav-item-active-accent": { light: "#dbeafe", dark: "#1e3a8a" },
			"--dsw-specific-bubble": { light: "#e8f2ff", dark: "#1e3a5f" },
			"--dsw-specific-bubble-highlight": { light: "#dbeafe", dark: "#1d4ed8" },
			"--dsw-specific-input-major": { light: "#ffffff", dark: "#1e222b" },
			"--dsw-specific-selector": { light: "#f1f5f9", dark: "#262b36" },
			"--dsw-specific-menu": { light: "rgba(255, 255, 255, 0.96)", dark: "rgba(28, 32, 41, 0.96)" },
			"--dsw-alias-border-l1": { light: "rgba(15, 23, 42, 0.05)", dark: "rgba(255, 255, 255, 0.06)" },
			"--dsw-alias-border-l2": { light: "rgba(15, 23, 42, 0.075)", dark: "rgba(255, 255, 255, 0.09)" },
			"--dsw-alias-border-l3": { light: "rgba(15, 23, 42, 0.09)", dark: "rgba(255, 255, 255, 0.11)" },
			"--dsw-alias-border-l4": { light: "rgba(15, 23, 42, 0.14)", dark: "rgba(255, 255, 255, 0.16)" },
			"--dsw-alias-label-primary": { light: "#0f172a", dark: "#f1f5f9" },
			"--dsw-alias-label-secondary": { light: "#475569", dark: "#94a3b8" },
			"--dsw-alias-label-tertiary": { light: "#64748b", dark: "#64748b" },
			"--dsw-alias-label-caption": { light: "#94a3b8", dark: "#475569" },
			"--dsw-alias-state-business-primary": { light: "#2563eb", dark: "#3b82f6" },
			"--dsw-alias-state-business-tertiary": { light: "#eff6ff", dark: "rgba(59, 130, 246, 0.16)" },
			"--dsw-alias-button-info-fill": { light: "#2563eb", dark: "#2563eb" },
			"--dsw-alias-button-info-hover": { light: "#1d4ed8", dark: "#3b82f6" },
			"--dsw-alias-button-elevated-fill": { light: "#ffffff", dark: "#1e222b" },
			"--dsw-alias-button-floating-fill": { light: "#ffffff", dark: "#1e222b" },
			"--dsw-alias-button-floating-hover": { light: "#f1f5f9", dark: "#282d39" },
			"--dsw-alias-interactive-bg-hover": { light: "rgba(15, 23, 42, 0.045)", dark: "rgba(255, 255, 255, 0.06)" },
			"--dsw-alias-interactive-bg-hover-solid": { light: "#edf1f7", dark: "#232834" },
			"--dsw-alias-interactive-bg-active": { light: "rgba(15, 23, 42, 0.08)", dark: "rgba(255, 255, 255, 0.1)" },
			"--dsw-alias-markdown-code-block": { light: "#f8fafc", dark: "#12151b" },
			"--dsw-alias-markdown-code-block-banner": { light: "#f1f5f9", dark: "#1a1e26" },
			"--dsw-alias-markdown-inline-code": { light: "#f1f5f9", dark: "#252a36" },
			"--dsw-alias-turn-trigger-bg": { light: "#f8fafc", dark: "#1b1f28" },
			"--dsw-alias-turn-trigger-bg-hover": { light: "#f1f5f9", dark: "#232834" }
		};

		const CODEX_CSS = `
:root {
  --dsw-radius-xs: 6px;
  --dsw-radius-sm: 8px;
  --dsw-radius-md: 9px;
  --dsw-radius-lg: 14px;
  --dsw-radius-xl: 16px;
  --dsw-radius-panel: 22px;
  --dsh-windows-titlebar-height: 38px;
}
.dsh-sci-evidence-card { margin: 6px 0; padding: 9px 12px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 8px; color: var(--dsw-alias-label-primary); font-size: 13px; }
.dsh-sci-evidence-card summary { cursor: pointer; line-height: 1.7; }
.dsh-sci-evidence-card pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 1.65; margin: 6px 0 12px; max-height: 420px; overflow: auto; }
.dsh-sci-evidence-card a { color: var(--dsw-alias-state-business-primary); display: inline-block; margin-right: 10px; overflow-wrap: anywhere; }
.dsh-sci-evidence-label { color: var(--dsw-alias-label-secondary); margin-top: 10px; }
.dsh-sci-evidence-section:focus { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 3px; }
.dsh-sci-evidence-error { border-color: #b45309; }
[data-approval-scroll] { white-space: pre-wrap; overflow-wrap: anywhere; }

/* Codex-like Windows frame & rounded white center card */
html[data-windows-titlebar] .pI_x6G_frame {
  --dsh-windows-content-radius: 14px !important;
  background: var(--dsw-specific-sidebar-fill) !important;
}
html[data-windows-titlebar] .pI_x6G_centerCol {
  background: var(--dsw-alias-bg-base) !important;
  border-radius: 14px 0 0 0 !important;
  border-top: 1px solid var(--dsw-alias-border-l2) !important;
  border-left: 1px solid var(--dsw-alias-border-l2) !important;
  box-shadow: -2px 0 12px rgba(15, 23, 42, 0.025);
}

/* Top titlebar quick actions (Research Workspace / Capture History) */
.dsh-sci-titlebar-nav {
  position: fixed;
  top: 5px;
  left: var(--dsh-windows-menu-start, 46px);
  height: 28px;
  z-index: 35;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  -webkit-app-region: no-drag;
  pointer-events: auto;
}
html:not([data-windows-titlebar]) .dsh-sci-titlebar-nav {
  display: none;
}
.dsh-sci-titlebar-btn {
  height: 26px;
  padding: 0 9px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 26px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  transition: background-color 0.12s ease, color 0.12s ease;
}
.dsh-sci-titlebar-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

/* Clean Codex-like sidebar */
.hHd-Xa_root {
  --dsh-sidebar-inline-padding: 12px;
  font-size: 13.5px;
}
.hHd-Xa_logoRow {
  height: 42px !important;
  margin-bottom: 2px !important;
  padding: 4px 4px 4px 6px !important;
}
/* Borderless, left-aligned "New chat" row matching Codex */
.hHd-Xa_root:not(.hHd-Xa_collapsed) .hHd-Xa_newSession {
  height: 32px !important;
  border-radius: 8px !important;
  border: none !important;
  background: transparent !important;
  box-shadow: none !important;
  font-size: 13.5px !important;
  font-weight: 500 !important;
  color: var(--dsw-alias-label-primary) !important;
  justify-content: flex-start !important;
  padding: 0 8px !important;
  margin: 2px 0 8px !important;
}
.hHd-Xa_root:not(.hHd-Xa_collapsed) .hHd-Xa_newSession:hover {
  background: var(--dsw-alias-interactive-bg-hover) !important;
}
.hHd-Xa_root:not(.hHd-Xa_collapsed) .hHd-Xa_newSessionContent {
  justify-content: flex-start !important;
  gap: 8px !important;
}
.hHd-Xa_panelRow {
  min-height: 32px !important;
  border-radius: 8px !important;
  margin: 0 !important;
  padding: 5px 8px !important;
  font-size: 13.5px !important;
}
.YDXeBa_projectRow,
.YDXeBa_sessionRow {
  border-radius: 8px !important;
  height: 30px !important;
  font-size: 13px !important;
}
.YDXeBa_sessionRow .YDXeBa_title,
.YDXeBa_projectRow .YDXeBa_title {
  font-size: 13px !important;
}
.YDXeBa_sessionRow.YDXeBa_selected {
  background: var(--dsw-specific-sidebar-nav-item-active) !important;
  font-weight: 500;
}
.bhn1Oq_sectionHeader {
  height: 28px !important;
  font-size: 11.5px !important;
  font-weight: 500 !important;
  color: var(--dsw-alias-label-tertiary) !important;
  letter-spacing: 0.01em;
}

/* Conversation header — compact and airy like Codex */
.wSkVaW_header {
  min-height: 48px !important;
  padding: 8px 22px 8px 20px !important;
  border-bottom: 1px solid var(--dsw-alias-border-l2) !important;
}
.wSkVaW_headerBlank {
  border-bottom: none !important;
}
.wSkVaW_crumbCurrent {
  font-size: 14px !important;
  font-weight: 600 !important;
  color: var(--dsw-alias-label-primary) !important;
}

/* User message bubble — soft rounded sky-blue pill */
.Sixlwa_bubble {
  border-radius: 16px !important;
  padding: 10px 16px !important;
  font-size: var(--dsh-content-font-size, 14px);
  line-height: 1.6 !important;
}
html body:not([data-ds-dark-theme]) .Sixlwa_bubble {
  background: #e8f2ff !important;
  color: #0f172a !important;
}

/* Floating pill composer card + circular blue send button */
.uV2eYG_root {
  padding-bottom: 14px !important;
}
.uV2eYG_card {
  border-radius: 20px !important;
  padding: 10px 8px 6px !important;
  gap: 8px !important;
  transition: box-shadow 0.15s ease, border-color 0.15s ease;
}
html body:not([data-ds-dark-theme]) .uV2eYG_card {
  background: #ffffff !important;
  box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.09), 0 6px 20px -4px rgba(15, 23, 42, 0.06) !important;
}
html body:not([data-ds-dark-theme]) .uV2eYG_card:focus-within {
  box-shadow: 0 0 0 1.5px rgba(37, 99, 235, 0.4), 0 10px 26px -6px rgba(15, 23, 42, 0.08) !important;
}
.uV2eYG_primary {
  background: #2563eb !important;
  width: 32px !important;
  height: 32px !important;
  border-radius: 999px !important;
  box-shadow: 0 2px 5px rgba(37, 99, 235, 0.25);
}
.uV2eYG_primary:hover:not(:disabled) {
  background: #1d4ed8 !important;
}

/* Empty-state hero — clean & minimalist */
.pXSMma_previewBadge {
  display: none !important;
}
.pXSMma_headline {
  font-size: 22px !important;
  font-weight: 600 !important;
  letter-spacing: -0.02em;
}
`;

		function installCodexStyles(ctx) {
			if (typeof document === "undefined") return;
			ctx.effect(() => {
				let tag = document.getElementById(CODEX_STYLE_ID);
				if (!tag) {
					tag = document.createElement("style");
					tag.id = CODEX_STYLE_ID;
				}
				tag.textContent = CODEX_CSS;
				document.head.appendChild(tag);
				return () => {
					tag?.remove();
				};
			}, "dsh-sci: codex theme stylesheet");
		}

		function installCodexThemeTokens(ctx) {
			if (!ctx.theme) return;
			ctx.effect(() => {
				const dispose = ctx.theme.overrideTokens("dsh-sci-brand", CODEX_THEME_TOKENS);
				const syncNativeOverlay = (snapshot) => {
					const scheme = snapshot?.active?.colorScheme === "dark" ? "dark" : "light";
					window.dshSciDesktop?.setTitleBarTheme?.(scheme);
				};
				syncNativeOverlay(ctx.theme.getTheme());
				const off = ctx.on("theme/change", syncNativeOverlay);
				return () => {
					off?.();
					dispose?.();
				};
			}, "dsh-sci: codex theme tokens");
		}

		function BrandGlyph({ size }) {
			const px = typeof size === "number" ? size : 22;
			return jsx("div", {
				"aria-hidden": "true",
				style: {
					width: px,
					height: px,
					borderRadius: Math.round(px * 0.28),
					background: "#0f172a",
					color: "#ffffff",
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					flexShrink: 0
				},
				children: jsxs("svg", {
					width: Math.round(px * 0.62),
					height: Math.round(px * 0.62),
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "2.1",
					strokeLinecap: "round",
					strokeLinejoin: "round",
					children: [
						jsx("path", { d: "M9 3h6" }),
						jsx("path", { d: "M10 3v5.4a2 2 0 0 1-.45 1.26L4.6 15.8A2.5 2.5 0 0 0 6.55 20h10.9a2.5 2.5 0 0 0 1.95-4.2l-4.95-6.14A2 2 0 0 1 14 8.4V3" }),
						jsx("path", { d: "M7.5 15h9" })
					]
				})
			});
		}

		function BrandMark({ size }) {
			return jsx(BrandGlyph, { size: typeof size === "number" ? size : 20 });
		}

		function HeroBrandMark({ size }) {
			return jsx(BrandGlyph, { size: typeof size === "number" ? size : 30 });
		}

		function BrandName() {
			return jsx("span", {
				style: {
					fontWeight: 600,
					fontSize: 15,
					fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
					letterSpacing: "-0.02em",
					color: "var(--dsw-alias-label-primary)"
				},
				children: "dsh-sci"
			});
		}

		function TitlebarQuickActions() {
			if (typeof window === "undefined" || !window.dshSciDesktop) return null;
			return jsxs("div", {
				className: "dsh-sci-titlebar-nav",
				children: [
					jsx("button", {
						type: "button",
						className: "dsh-sci-titlebar-btn",
						onClick: () => window.dshSciDesktop?.openResearchWorkspace?.("owner"),
						title: "按需审阅研究证据、实验设计和报告；可直接在当前对话开展研究",
						children: "研究记录"
					}),
					jsx("button", {
						type: "button",
						className: "dsh-sci-titlebar-btn",
						onClick: () => window.dshSciDesktop?.openCaptureHistory?.(),
						title: "查看本地捕获历史与服务配置 (Capture History)",
						children: "捕获与配置"
					})
				]
			});
		}

		const inject = ["slots", "theme"];
		function apply(ctx) {
			installCodexStyles(ctx);
			installCodexThemeTokens(ctx);
			ctx.slots.inject("tool.call.toolview", function* () {
				for (const key of Object.keys(RESEARCH_TITLES)) yield ctx.slots.register({ name: "tool.call.toolview", key }, ResearchToolView);
			});
			// Fragment links only reveal evidence already projected in this conversation.
			// They cannot read other projects, create reading receipts, or execute actions.
			ctx.effect(() => {
				const onClick = (event) => {
					const href = event.target?.closest?.("a")?.getAttribute("href");
					if (typeof href === "string" && /^#dsh-sci-evidence-[A-Za-z0-9._:-]{1,160}$/.test(href) && revealEvidence(href.slice(1))) { event.preventDefault(); event.stopPropagation(); }
				};
				document.addEventListener("click", onClick, true);
				return () => document.removeEventListener("click", onClick, true);
			}, "dsh-sci: local evidence links");
			ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.inject("sidebar.brand.name", function* () {
				yield ctx.slots.register({ name: "sidebar.brand.mark" }, BrandMark);
				yield ctx.slots.register({ name: "sidebar.brand.name" }, BrandName);
			}));
			ctx.slots.inject("conversation.hero.brand.mark", () =>
				ctx.slots.register({ name: "conversation.hero.brand.mark" }, HeroBrandMark)
			);
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register({ name: "shell.overlay", id: "dsh-sci-titlebar-actions", order: 10 }, TitlebarQuickActions)
			);
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
