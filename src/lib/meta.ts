/** What the page and the Discord embed know about a room. Produced by RoomDO.snapshot(). */
export interface RoomSnapshot {
  hostName: string;
  live: boolean;
  started: boolean;
  session: string;
  viewers: number;
  hasThumb: boolean;
}

export interface PageMeta {
  title: string;
  description: string;
  image: string;
  imageWidth: number;
  imageHeight: number;
  themeColor: string;
  url: string;
}

export const BANNER = { width: 1200, height: 630 };
export const THUMB = { width: 640, height: 360 };

export function roomMeta(room: RoomSnapshot | null, origin: string, id: string): PageMeta {
  const url = `${origin}/s/${id}`;
  if (room?.live) {
    const people = room.viewers === 1 ? "1 person" : `${room.viewers} people`;
    return {
      title: `${room.hostName} is sharing their screen`,
      description: `${people} watching. Tap to watch, no login needed.`,
      image: room.hasThumb ? `${origin}/t/${id}/thumb.jpg?v=${room.session}` : `${origin}/banner.png`,
      imageWidth: room.hasThumb ? THUMB.width : BANNER.width,
      imageHeight: room.hasThumb ? THUMB.height : BANNER.height,
      themeColor: "#da373c",
      url
    };
  }
  const name = room?.hostName ?? "Someone";
  return {
    title: `${name}'s screen`,
    description: "Not live right now. Tap to wait for the stream, no login needed.",
    image: `${origin}/banner.png`,
    imageWidth: BANNER.width,
    imageHeight: BANNER.height,
    themeColor: "#5865f2",
    url
  };
}

export function landingMeta(origin: string): PageMeta {
  return {
    title: "peek. Share your screen with one link",
    description: "Two clicks to share. Anyone with the link can watch.",
    image: `${origin}/banner.png`,
    imageWidth: BANNER.width,
    imageHeight: BANNER.height,
    themeColor: "#5865f2",
    url: origin
  };
}

/** Meta tags in the shape TanStack Router's head() expects. */
export function metaTags(meta: PageMeta): Array<Record<string, string>> {
  return [
    { title: meta.title },
    { name: "description", content: meta.description },
    { name: "theme-color", content: meta.themeColor },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: "peek" },
    { property: "og:title", content: meta.title },
    { property: "og:description", content: meta.description },
    { property: "og:url", content: meta.url },
    { property: "og:image", content: meta.image },
    { property: "og:image:width", content: String(meta.imageWidth) },
    { property: "og:image:height", content: String(meta.imageHeight) },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: meta.title },
    { name: "twitter:description", content: meta.description },
    { name: "twitter:image", content: meta.image }
  ];
}

/** Public origin for absolute URLs. Honors proxies and an explicit PUBLIC_URL. */
export function originOf(request: Request, publicUrl?: string): string {
  if (publicUrl) return publicUrl.replace(/\/$/, "");
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  return `${proto}://${host}`;
}
