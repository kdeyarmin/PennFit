// In-memory, session-lived mutable state for demo mode. Seeded from
// the static fixtures at module load; mutated by write handlers so the
// demo feels interactive (edit your profile and it sticks; post a
// review and it appears; send a message and "support" replies). All
// state resets on page reload — which is exactly when the demo toggle
// reloads — so there's no cross-session leakage.

import type {
  ShopMeProfile,
  AccountMessage,
  AccountThread,
} from "@/lib/account-api";
import type { CommunicationPreferences } from "@/lib/account-api";
import type { MyReview, OrderHistoryItem } from "@/lib/shop-api";
import { demoProfile, demoClinicalInfo, demoCommPrefs } from "./account";
import { demoOrderHistory } from "./orders";
import { minutesAgo, NOW_ISO } from "./dates";
import type { ShopClinicalInfoResponse } from "@/lib/account-api";

interface DemoState {
  profile: ShopMeProfile;
  clinical: ShopClinicalInfoResponse;
  commPrefs: CommunicationPreferences;
  reviews: Map<string, MyReview>;
  thread: AccountThread;
  messages: AccountMessage[];
  unreadFromCsr: number;
  placedOrders: OrderHistoryItem[];
}

let state: DemoState | null = null;

function seed(): DemoState {
  return {
    profile: demoProfile(),
    clinical: demoClinicalInfo(),
    commPrefs: demoCommPrefs(),
    reviews: new Map(),
    thread: {
      id: "demo-thread-1",
      status: "open",
      lastMessageAt: minutesAgo(90),
      createdAt: minutesAgo(180),
    },
    messages: [
      {
        id: "demo-msg-1",
        direction: "outbound",
        senderRole: "customer",
        body: "Hi! My new mask is leaking a little near the bridge of my nose. Any tips?",
        createdAt: minutesAgo(180),
        deliveryStatus: "delivered",
      },
      {
        id: "demo-msg-2",
        direction: "inbound",
        senderRole: "agent",
        body: "Happy to help! Try loosening the top straps slightly and re-seating the cushion with the machine running. If it keeps leaking, you may be between sizes — we can send a fit kit. 🙂",
        createdAt: minutesAgo(90),
        deliveryStatus: "delivered",
      },
    ],
    unreadFromCsr: 1,
    placedOrders: [],
  };
}

function get(): DemoState {
  if (!state) state = seed();
  return state;
}

export const demoStore = {
  getProfile(): ShopMeProfile {
    return get().profile;
  },
  updateProfile(patch: Partial<ShopMeProfile>): ShopMeProfile {
    const s = get();
    s.profile = { ...s.profile, ...patch };
    // Keep clinical-info device/physician in sync with the profile.
    s.clinical = {
      ...s.clinical,
      cpapDevice: s.profile.cpapDevice,
      physicianInfo: s.profile.physicianInfo,
    };
    return s.profile;
  },
  getClinical(): ShopClinicalInfoResponse {
    return get().clinical;
  },
  updateClinical(
    patch: Partial<ShopClinicalInfoResponse>,
  ): ShopClinicalInfoResponse {
    const s = get();
    s.clinical = { ...s.clinical, ...patch };
    if (patch.cpapDevice !== undefined) s.profile.cpapDevice = patch.cpapDevice;
    if (patch.physicianInfo !== undefined)
      s.profile.physicianInfo = patch.physicianInfo;
    return s.clinical;
  },
  getCommPrefs(): CommunicationPreferences {
    return get().commPrefs;
  },
  updateCommPrefs(
    patch: Partial<CommunicationPreferences>,
  ): CommunicationPreferences {
    const s = get();
    s.commPrefs = { ...s.commPrefs, ...patch };
    return s.commPrefs;
  },
  getReview(productId: string): MyReview | null {
    return get().reviews.get(productId) ?? null;
  },
  upsertReview(
    productId: string,
    payload: { rating: MyReview["rating"]; title: string | null; body: string },
  ): MyReview {
    const s = get();
    const existing = s.reviews.get(productId);
    const review: MyReview = {
      id: existing?.id ?? `demo-review-${productId}`,
      rating: payload.rating,
      title: payload.title,
      body: payload.body,
      // Auto-approve in the demo so the customer sees it appear live.
      status: "approved",
      moderationNote: null,
      createdAt: existing?.createdAt ?? NOW_ISO(),
      updatedAt: NOW_ISO(),
    };
    s.reviews.set(productId, review);
    return review;
  },
  deleteReview(productId: string): void {
    get().reviews.delete(productId);
  },
  getMessages(): {
    thread: AccountThread;
    messages: AccountMessage[];
    unreadFromCsr: number;
  } {
    const s = get();
    return {
      thread: s.thread,
      messages: s.messages,
      unreadFromCsr: s.unreadFromCsr,
    };
  },
  markMessagesRead(): void {
    get().unreadFromCsr = 0;
  },
  postMessage(body: string): {
    threadId: string;
    messageId: string;
    threadCreated: boolean;
  } {
    const s = get();
    const id = `demo-msg-${s.messages.length + 1}`;
    s.messages.push({
      id,
      direction: "outbound",
      senderRole: "customer",
      body,
      createdAt: NOW_ISO(),
      deliveryStatus: "delivered",
    });
    s.thread.lastMessageAt = NOW_ISO();
    // Canned auto-reply so the thread feels alive.
    s.messages.push({
      id: `${id}-reply`,
      direction: "inbound",
      senderRole: "agent",
      body: "Thanks for reaching out! A PennFit specialist will follow up shortly. (This is a demo reply.)",
      createdAt: new Date(Date.now() + 1500).toISOString(),
      deliveryStatus: "delivered",
    });
    s.unreadFromCsr += 1;
    return { threadId: s.thread.id, messageId: id, threadCreated: false };
  },
  orderHistory(): OrderHistoryItem[] {
    const s = get();
    return [...s.placedOrders, ...demoOrderHistory().orders];
  },
  recordPlacedOrder(order: OrderHistoryItem): void {
    get().placedOrders.unshift(order);
  },
  /** Test-only reset. */
  reset(): void {
    state = null;
  },
};
