import type { CollectionEntry } from "astro:content";
import { siteConfig } from "@/site.config";

export function getFormattedDate(
	date: Date | undefined,
	options?: Intl.DateTimeFormatOptions,
): string {
	if (date === undefined) {
		return "Invalid Date";
	}

	return new Intl.DateTimeFormat(siteConfig.date.locale, {
		...(siteConfig.date.options as Intl.DateTimeFormatOptions),
		...options,
	}).format(date);
}

export function collectionDateSort(
	a: CollectionEntry<"post" | "note">,
	b: CollectionEntry<"post" | "note">,
) {
	if ("order" in a.data && "order" in b.data) {
		if (a.data.order !== undefined && b.data.order !== undefined) {
			return b.data.order - a.data.order;
		}
	}

	return b.data.publishDate.getTime() - a.data.publishDate.getTime();
}
