import type { CustomNavItem } from "../types";

/**
 * 自定义导航前端 API 客户端 —— 自包含，不依赖 src/web/lib/api.ts，
 * 保证本功能文件夹可以整体独立同步，与主程序升级互不牵连。
 */

interface Envelope<T> {
	ok: boolean;
	data?: T;
	error?: { code: string; message: string };
}

export class CustomNavApiError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		credentials: "same-origin",
		headers: init?.body ? { "Content-Type": "application/json" } : undefined,
		...init,
	});
	let payload: Envelope<T> | null = null;
	try {
		payload = (await response.json()) as Envelope<T>;
	} catch {
		payload = null;
	}
	if (!response.ok || !payload?.ok) {
		throw new CustomNavApiError(
			response.status,
			payload?.error?.code ?? "request_failed",
			payload?.error?.message ?? `请求失败（HTTP ${response.status}）`,
		);
	}
	return payload.data as T;
}

export const navApi = {
	get: () => request<{ items: CustomNavItem[] }>("/api/custom-nav"),
	put: (items: CustomNavItem[]) =>
		request<{ items: CustomNavItem[] }>("/api/custom-nav", { method: "PUT", body: JSON.stringify({ items }) }),
};
