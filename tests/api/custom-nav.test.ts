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

	it("接受 36 位完整 UUID 样式的 id（前端曾用它导致保存被拒的回归用例）", async () => {
		const { cookie } = await bootstrap();
		const uuid = "518cc80b-0609-8474-3d9d-535751d16839";
		const saved = await call<Envelope<{ items: unknown[] }>>(NAV, {
			method: "PUT",
			cookie,
			body: JSON.stringify({ items: [{ id: uuid, name: "驾驶舱", url: "https://memos.tianrong.ltd/embed/stocks?token=abc&w=1200", mode: "embed" }] }),
		});
		expect(saved.status).toBe(200);
		expect(saved.body.data.items).toHaveLength(1);
		expect(saved.body.data.items[0]).toMatchObject({ id: uuid, name: "驾驶舱" });
	});

	it("settings 表里只存一条 custom_nav_items，无需迁移", async () => {
		const { cookie } = await bootstrap();
		const items = [{ id: "only", name: "仅此一项", url: "https://example.com", mode: "embed" }];
		await call(NAV, { method: "PUT", cookie, body: JSON.stringify({ items }) });

		const envRow = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'custom_nav_items'`).first<{ value: string }>();
		expect(envRow?.value).toBe(JSON.stringify(items));
	});

	it("尺寸不再由菜单配置：历史数据里的 width / height 会被丢弃", async () => {
		const { cookie } = await bootstrap();
		const saved = await call<Envelope<{ items: Array<Record<string, unknown>> }>>(NAV, {
			method: "PUT",
			cookie,
			body: JSON.stringify({
				items: [{ id: "legacy", name: "历史定尺面板", url: "https://example.com/panel", mode: "embed", width: 1200, height: 800 }],
			}),
		});
		expect(saved.status).toBe(200);
		// 嵌入页尺寸改由容器与内容高度统一控制，旧的宽高配置不再保留
		expect(saved.body.data.items[0]).toEqual({ id: "legacy", name: "历史定尺面板", url: "https://example.com/panel", mode: "embed" });

		const fetched = await call<Envelope<{ items: Array<Record<string, unknown>> }>>(NAV, { cookie });
		expect(fetched.body.data.items).toEqual(saved.body.data.items);
	});

	it("高度消息 type 可选：保留合法值并去除首尾空白，留空 / 超长 / 含空白视为自动识别", async () => {
		const { cookie } = await bootstrap();
		const base = { url: "https://example.com/panel", mode: "embed" };
		const saved = await call<Envelope<{ items: Array<Record<string, unknown>> }>>(NAV, {
			method: "PUT",
			cookie,
			body: JSON.stringify({
				items: [
					{ ...base, id: "memos", name: "memos", heightMessageType: "  memos-embed-height  " },
					{ ...base, id: "blank", name: "留空", heightMessageType: "   " },
					{ ...base, id: "long", name: "超长", heightMessageType: "h".repeat(81) },
					{ ...base, id: "space", name: "含空白", heightMessageType: "has space" },
				],
			}),
		});
		expect(saved.status).toBe(200);
		const items = saved.body.data.items;
		expect(items[0].heightMessageType).toBe("memos-embed-height");
		// 三种写坏的情况都退回「自动识别」，不因此拒绝整条菜单
		expect(items[1].heightMessageType).toBeUndefined();
		expect(items[2].heightMessageType).toBeUndefined();
		expect(items[3].heightMessageType).toBeUndefined();
	});
});
