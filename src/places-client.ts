/**
 * Thin client for the Google Places API (New).
 *
 * Docs:
 *  - https://developers.google.com/maps/documentation/places/web-service/text-search
 *  - https://developers.google.com/maps/documentation/places/web-service/place-details
 *
 * The New API uses a single `X-Goog-Api-Key` header and a `X-Goog-FieldMask`
 * header that must enumerate every field you want back. The FieldMask is what
 * makes per-request billing tiers work; do not request fields you do not need.
 */

const PLACES_BASE = "https://places.googleapis.com/v1";

export interface PlaceSearchResult {
  place_id: string;
  name: string;
  formatted_address: string;
  types: string[];
  business_status?: string;
  rating?: number;
  user_ratings_total?: number;
  primary_type?: string;
}

export interface PlaceDetailsResult {
  place_id: string;
  name: string;
  formatted_address: string;
  international_phone_number?: string;
  national_phone_number?: string;
  website?: string;
  rating?: number;
  user_ratings_total?: number;
  business_status?: string;
  types: string[];
  primary_type?: string;
  google_maps_uri?: string;
  opening_hours?: {
    weekday_descriptions?: string[];
    open_now?: boolean;
  };
}

function apiKey(): string {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) {
    throw new Error(
      "GOOGLE_PLACES_API_KEY is not set on the server. Add it in the Vercel project env vars.",
    );
  }
  return key;
}

/**
 * Text Search. Returns up to ~20 candidates ranked by Google's relevance.
 *
 * We intentionally keep the FieldMask narrow: just enough for the Outreach Bot
 * to decide which Place-IDs are worth a `place_details` follow-up.
 *
 * BILLING (2026-09-02, August invoice 5.62 EUR): Google bills a request at the
 * highest SKU any requested field belongs to, and since March 2025 the free
 * tier is a per-SKU monthly cap instead of a $200 credit. `places.rating` and
 * `places.userRatingCount` are Text Search ENTERPRISE fields (1,000 free calls
 * per month, then $35/1k); everything else below is PRO (5,000 free, $32/1k).
 * Nothing in the Outreach Bot reads rating off a search hit, so the default
 * mask stays Pro. Callers that really need rating on the hit list (the
 * teardown's Vergleichs-Praxis ranking) opt in with `withRating`, and pay.
 */
export async function textSearch(
  query: string,
  options: { languageCode?: string; regionCode?: string; withRating?: boolean } = {},
): Promise<PlaceSearchResult[]> {
  const fieldMask = [
    "places.id",
    "places.displayName",
    "places.formattedAddress",
    "places.types",
    "places.primaryType",
    "places.businessStatus",
    ...(options.withRating ? ["places.rating", "places.userRatingCount"] : []),
  ].join(",");

  const res = await fetch(`${PLACES_BASE}/places:searchText`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey(),
      "X-Goog-FieldMask": fieldMask,
    },
    body: JSON.stringify({
      textQuery: query,
      languageCode: options.languageCode ?? "de",
      regionCode: options.regionCode ?? "DE",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Places textSearch failed: ${res.status} ${body}`);
  }

  const json = (await res.json()) as {
    places?: Array<{
      id: string;
      displayName?: { text?: string };
      formattedAddress?: string;
      types?: string[];
      primaryType?: string;
      businessStatus?: string;
      rating?: number;
      userRatingCount?: number;
    }>;
  };

  return (json.places ?? []).map((p) => ({
    place_id: p.id,
    name: p.displayName?.text ?? "",
    formatted_address: p.formattedAddress ?? "",
    types: p.types ?? [],
    primary_type: p.primaryType,
    business_status: p.businessStatus,
    rating: p.rating,
    user_ratings_total: p.userRatingCount,
  }));
}

export interface NearbySearchResult {
  place_id: string;
  name: string;
  formatted_address: string;
  types: string[];
  primary_type?: string;
  business_status?: string;
}

/**
 * Nearby Search (New). Type-based, no text query, max 20 results, NO
 * pagination — the grid tool compensates by subdividing saturated circles.
 *
 * FieldMask deliberately narrower than textSearch: no rating/userRatingCount,
 * which keeps every grid call in the cheaper Pro SKU (ratings sit in the
 * Enterprise tier for Nearby Search). The grid only needs the candidate
 * shape; enrichment happens later via place_details.
 */
export async function nearbySearch(
  params: {
    latitude: number;
    longitude: number;
    radius: number;
    includedTypes: string[];
  },
  options: { languageCode?: string; regionCode?: string } = {},
): Promise<NearbySearchResult[]> {
  const fieldMask = [
    "places.id",
    "places.displayName",
    "places.formattedAddress",
    "places.types",
    "places.primaryType",
    "places.businessStatus",
  ].join(",");

  const res = await fetch(`${PLACES_BASE}/places:searchNearby`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey(),
      "X-Goog-FieldMask": fieldMask,
    },
    body: JSON.stringify({
      locationRestriction: {
        circle: {
          center: { latitude: params.latitude, longitude: params.longitude },
          radius: params.radius,
        },
      },
      includedTypes: params.includedTypes,
      maxResultCount: 20,
      // DISTANCE makes saturation semantics exact: a full page of 20 means
      // "the 20 CLOSEST are returned and more exist further out", which is
      // precisely the invariant the quadtree subdivision in grid.ts relies on.
      rankPreference: "DISTANCE",
      languageCode: options.languageCode ?? "de",
      regionCode: options.regionCode ?? "DE",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Places nearbySearch failed: ${res.status} ${body}`);
  }

  const json = (await res.json()) as {
    places?: Array<{
      id: string;
      displayName?: { text?: string };
      formattedAddress?: string;
      types?: string[];
      primaryType?: string;
      businessStatus?: string;
    }>;
  };

  return (json.places ?? []).map((p) => ({
    place_id: p.id,
    name: p.displayName?.text ?? "",
    formatted_address: p.formattedAddress ?? "",
    types: p.types ?? [],
    primary_type: p.primaryType,
    business_status: p.businessStatus,
  }));
}

/**
 * Place Details. One call per place_id. Returns the full record the Outreach
 * Bot uses for Identity-Enrichment (website + phone + reviews count + hours).
 */
export async function placeDetails(
  placeId: string,
  options: { languageCode?: string; regionCode?: string } = {},
): Promise<PlaceDetailsResult> {
  const fieldMask = [
    "id",
    "displayName",
    "formattedAddress",
    "internationalPhoneNumber",
    "nationalPhoneNumber",
    "websiteUri",
    "rating",
    "userRatingCount",
    "businessStatus",
    "types",
    "primaryType",
    "googleMapsUri",
    "regularOpeningHours",
  ].join(",");

  const url = new URL(`${PLACES_BASE}/places/${encodeURIComponent(placeId)}`);
  url.searchParams.set("languageCode", options.languageCode ?? "de");
  url.searchParams.set("regionCode", options.regionCode ?? "DE");

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-Goog-Api-Key": apiKey(),
      "X-Goog-FieldMask": fieldMask,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Places placeDetails failed: ${res.status} ${body}`);
  }

  const p = (await res.json()) as {
    id: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    internationalPhoneNumber?: string;
    nationalPhoneNumber?: string;
    websiteUri?: string;
    rating?: number;
    userRatingCount?: number;
    businessStatus?: string;
    types?: string[];
    primaryType?: string;
    googleMapsUri?: string;
    regularOpeningHours?: {
      openNow?: boolean;
      weekdayDescriptions?: string[];
    };
  };

  return {
    place_id: p.id,
    name: p.displayName?.text ?? "",
    formatted_address: p.formattedAddress ?? "",
    international_phone_number: p.internationalPhoneNumber,
    national_phone_number: p.nationalPhoneNumber,
    website: p.websiteUri,
    rating: p.rating,
    user_ratings_total: p.userRatingCount,
    business_status: p.businessStatus,
    types: p.types ?? [],
    primary_type: p.primaryType,
    google_maps_uri: p.googleMapsUri,
    opening_hours: p.regularOpeningHours
      ? {
          open_now: p.regularOpeningHours.openNow,
          weekday_descriptions: p.regularOpeningHours.weekdayDescriptions,
        }
      : undefined,
  };
}
