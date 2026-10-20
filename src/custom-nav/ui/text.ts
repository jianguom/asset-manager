/**
 * 自定义导航 —— 自包含双语文案
 *
 * 刻意不写进 src/shared/locales/zh.ts|en.ts：那些是上游文件，
 * 加文案会产生多余的升级冲突面。这里按当前语言取一份小字典即可。
 */
import type { ResolvedLanguage } from "../../shared/i18n";

export interface NavText {
	manage: string;
	add: string;
	save: string;
	cancel: string;
	close: string;
	edit: string;
	delete: string;
	moveUp: string;
	moveDown: string;
	name: string;
	url: string;
	mode: string;
	embed: string;
	tab: string;
	namePlaceholder: string;
	urlPlaceholder: string;
	width: string;
	height: string;
	sizeAuto: string;
	sizeHint: string;
	invalidSize: string;
	empty: string;
	notFound: string;
	openTab: string;
	nameRequired: string;
	invalidUrl: string;
	itemsCount: (n: number) => string;
}

const DICT: { zh: NavText; en: NavText } = {
	zh: {
		manage: "管理菜单",
		add: "添加",
		save: "保存",
		cancel: "取消",
		close: "关闭",
		edit: "编辑",
		delete: "删除",
		moveUp: "上移",
		moveDown: "下移",
		name: "菜单名称",
		url: "页面地址",
		mode: "打开方式",
		embed: "嵌入当前页面",
		tab: "新标签打开",
		namePlaceholder: "例如：我的面板",
		urlPlaceholder: "https://example.com",
		width: "宽度(px)",
		height: "高度(px)",
		sizeAuto: "留空 = 自适应",
		sizeHint: "仅嵌入方式有效：填了按此尺寸锁死，留空则自适应",
		invalidSize: "尺寸需为 100–4000 之间的整数，或留空自适应",
		empty: "还没有自定义菜单",
		notFound: "找不到该自定义菜单",
		openTab: "在新标签打开",
		nameRequired: "请输入菜单名称",
		invalidUrl: "请输入有效的 http(s) 地址",
		itemsCount: (n: number) => (n ? `共 ${n} 项` : ""),
	},
	en: {
		manage: "Manage menus",
		add: "Add",
		save: "Save",
		cancel: "Cancel",
		close: "Close",
		edit: "Edit",
		delete: "Delete",
		moveUp: "Move up",
		moveDown: "Move down",
		name: "Menu name",
		url: "Page URL",
		mode: "Open in",
		embed: "Embed in page",
		tab: "New tab",
		namePlaceholder: "e.g. My dashboard",
		urlPlaceholder: "https://example.com",
		width: "Width (px)",
		height: "Height (px)",
		sizeAuto: "blank = auto",
		sizeHint: "Embed mode only: set a size to pin the iframe, or leave blank to auto-fit",
		invalidSize: "Size must be an integer between 100 and 4000, or blank for auto",
		empty: "No custom menus yet",
		notFound: "Custom menu not found",
		openTab: "Open in new tab",
		nameRequired: "Please enter a menu name",
		invalidUrl: "Please enter a valid http(s) URL",
		itemsCount: (n: number) => (n ? `${n} item(s)` : ""),
	},
} as const;

export function navText(lang: ResolvedLanguage): NavText {
	return lang === "en" ? DICT.en : DICT.zh;
}
