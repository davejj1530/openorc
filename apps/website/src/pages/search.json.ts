import type { APIRoute } from "astro";
import { getPublishedReleases } from "../data/changelog";
import { searchEntries } from "../data/search-index";

export const GET: APIRoute = async () => Response.json(searchEntries(await getPublishedReleases()));
