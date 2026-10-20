/**
 * 自定义导航 —— 模块级缓存
 *
 * 顶栏（CustomNav）与嵌入页（CustomNavPage）都会读同一份配置，
 * 用模块级 Promise 缓存避免重复请求；管理面板保存后写入新值。
 */
import type { CustomNavItem } from "../types";
import { navApi } from "./api";

let cached: Promise<CustomNavItem[]> | null = null;

export function getNavItems(force = false): Promise<CustomNavItem[]> {
	if (!cached || force) {
		cached = navApi.get().then((res) => res.items).catch((error) => {
			cached = null;
			throw error;
		});
	}
	return cached;
}

/** 保存整表并更新缓存 */
export async function saveNavItems(items: CustomNavItem[]): Promise<CustomNavItem[]> {
	const saved = await navApi.put(items).then((res) => res.items);
	cached = Promise.resolve(saved);
	return saved;
}
