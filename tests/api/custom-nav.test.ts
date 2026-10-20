import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, call, clearAll } from "../helpers";

interface Envelope<T> {
	ok: boolean;
	data: T;
}

const NAV = "/api/custom-nav";

describe("自定义导航菜单（src/custom-nav/）", () => {
	beforeEach(async () => {
		await clearAll();
	});

	it("已初始化但未登录（公开只读默认关闭）返回 401", async () => {
		await bootstrap();
		const response = await call(NAV);
		expect(response.status).toBe(401);
	});

	it("初始为空列表，PUT 后可读回，且可整体覆盖", async () => {
		const { cookie } = await bootstrap();

		const empty = await call<Envelope<{ items: unknown[] }>>(NAV, { cookie });
		expect(empty.status).toBe(200);
		expect(empty.body.data.items).toEqual([]);

		const items = [
			{ id: "panel-a", name: "我的面板", url: "https://example.com/panel", mode: "embed" },
			{ id: "docs-b", name: "文档", url: "https://example.org/docs", mode: "tab" },
		];
		const saved = await call<Envelope<{ items: unknown[] }>>(NAV, {
			method: "PUT",
			cookie,
			body: JSON.stringify({ items }),
		});
		expect(saved.status).toBe(200);
		expect(saved.body.data.items).toEqual(items);

		const fetched = await call<Envelope<{ items: unknown[] }>>(NAV, { cookie });
		expect(fetched.body.data.items).toEqual(items);

		// 覆盖为只保留一项
		const replaced = await call<Envelope<{ items: unknown[] }>>(NAV, {
			method: "PUT",
			cookie,
			body: JSON.stringify({ items: items.slice(0, 1) }),
		});
		expect(replaced.status).toBe(200);
		const afterReplace = await call<Envelope<{ items: unknown[] }>>(NAV, { cookie });
		expect(afterReplace.body.data.items).toHaveLength(1);
	});

	it("拒绝非法地址 / 空名称 / 非法 id", async () => {
		const { cookie } = await bootstrap();
		const base = { id: "a1", name: "x", url: "https://example.com", mode: "embed" };

		const badUrl = await call(NAV, { method: "PUT", cookie, body: JSON.stringify({ items: [{ ...base, url: "javascript:alert(1)" }] }) });
		expect(badUrl.status).toBe(400);

		const badName = await call(NAV, { method: "PUT", cookie, body: JSON.stringify({ items: [{ ...base, name: "  " }] }) });
		expect(badName.status).toBe(400);

		const badId = await call(NAV, { method: "PUT", cookie, body: JSON.stringify({ items: [{ ...base, id: "../evil" }] }) });
		expect(badId.status).toBe(400);
	});

	it("settings 表里只存一条 custom_nav_items，无需迁移", async () => {
		const { cookie } = await bootstrap();
		const items = [{ id: "only", name: "仅此一项", url: "https://example.com", mode: "embed" }];
		await call(NAV, { method: "PUT", cookie, body: JSON.stringify({ items }) });

		const envRow = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'custom_nav_items'`).first<{ value: string }>();
		expect(envRow?.value).toBe(JSON.stringify(items));
	});
});
