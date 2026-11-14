import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { motion, AnimatePresence, MotionConfig } from 'motion/react';
import {
  Search,
  MessageSquarePlus,
  Send,
  ArrowLeft,
  Check,
  CheckCheck,
  LogOut,
  UserPlus,
  Smile,
  Moon,
  Sun,
  X,
  Users,
  Trash2,
  MoreVertical,
  Lock,
  MessageSquare,
  Settings,
  Image as ImageIcon,
  ChevronRight,
  Plus,
  Camera,
  RefreshCw,
  RotateCcw,
  Upload,
} from 'lucide-react';
import { initializeApp, getApps } from 'firebase/app';
import { getAnalytics, isSupported as isAnalyticsSupported } from 'firebase/analytics';
import {
  getDatabase,
  ref,
  set,
  update,
  remove,
  onValue,
  onDisconnect,
  type Database,
} from 'firebase/database';

// ============================================================================
// Types & Constants
// ============================================================================

type MessageStatus = 'sent' | 'delivered' | 'read';

type WallpaperId =
  | 'classic'
  | 'emerald'
  | 'ocean'
  | 'lavender'
  | 'sand'
  | 'minimal';

interface WallpaperTheme {
  id: WallpaperId;
  name: string;
  description: string;
  cssClass: string;
  defaultDoodle: boolean;
}

interface UserAccount {
  id: string; // normalized lowercase handle
  displayName: string;
  about: string;
  avatarColor: string;
  isRegistered: boolean; // true once the user has logged in at least once
  createdAt: number;
  lastSeen: number;
  wallpaper?: WallpaperId;
  wallpaperDoodle?: boolean;
}

interface ContactEntry {
  userId: string;
  nickname?: string;
  addedAt: number;
}

interface MessageRecord {
  id: string;
  senderId: string;
  recipientId: string;
  text: string;
  imageBase64?: string;
  timestamp: number;
  status: MessageStatus;
  reactions?: Record<string, string>; // userId -> emoji
}

interface ActiveSession {
  userId: string;
  lastHeartbeat: number;
  typingTo?: string | null;
}

interface AppStore {
  users: Record<string, UserAccount>;
  contacts: Record<string, Record<string, ContactEntry>>;
  messages: MessageRecord[];
  activeSessions: Record<string, ActiveSession>;
}

const STORAGE_KEY = 'wa_messenger_store_v1';
const THEME_KEY = 'wa_messenger_theme_v1';
const TAB_ID_KEY = 'wa_messenger_tab_id';
const SESSION_USER_KEY = 'wa_messenger_session_user';
const CHANNEL_NAME = 'wa_messenger_sync_v1';
const SESSION_TIMEOUT_MS = 15000;

function toRtdbKey(id: string): string {
  return id.replace(/[.#$\[\]/]/g, '_');
}

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY?.trim() || "AIzaSyDMUTV5Nqjiv2_5T6AhyF-VlZQCihiC84k",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN?.trim() || "whatsapp-8e70c.firebaseapp.com",
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL?.trim() || "https://whatsapp-8e70c-default-rtdb.firebaseio.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID?.trim() || "whatsapp-8e70c",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET?.trim() || "whatsapp-8e70c.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim() || "736946034076",
  appId: import.meta.env.VITE_FIREBASE_APP_ID?.trim() || "1:736946034076:web:65acafda98404bfcc66459",
  measurementId: "G-HL1XMLZ37G",
};

function initRealtimeDb(): Database | null {
  if (!firebaseConfig.databaseURL || !firebaseConfig.apiKey) return null;

  try {
    const app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
    if (typeof window !== 'undefined') {
      void isAnalyticsSupported()
        .then((supported) => {
          if (supported) {
            getAnalytics(app);
          }
        })
        .catch(() => {});
    }
    return getDatabase(app);
  } catch (err) {
    console.warn('Firebase Realtime Database initialization skipped:', err);
    return null;
  }
}

const rtdb = initRealtimeDb();

const AVATAR_PALETTE = [
  '#008069',
  '#027EB5',
  '#6B4FBB',
  '#B84A62',
  '#C26D1F',
  '#1F7A6E',
  '#4A6B82',
  '#7D5A50',
];

const QUICK_EMOJIS = [
  '😀', '😂', '🥹', '😍', '🙌', '👍', '🙏', '🔥',
  '🎉', '❤️', '✨', '😎', '🤔', '😅', '👋', '💯',
  '☕', '🚀', '📌', '✅', '👀', '💬', '📅', '🤝',
];

const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

const WALLPAPER_THEMES: WallpaperTheme[] = [
  {
    id: 'classic',
    name: 'Classic Stone',
    description: 'Traditional warm parchment',
    cssClass: 'wallpaper-classic',
    defaultDoodle: true,
  },
  {
    id: 'emerald',
    name: 'Soft Mint',
    description: 'Subtle sage-tinted canvas',
    cssClass: 'wallpaper-emerald',
    defaultDoodle: true,
  },
  {
    id: 'ocean',
    name: 'Coastal Slate',
    description: 'Calm cool blue-gray',
    cssClass: 'wallpaper-ocean',
    defaultDoodle: true,
  },
  {
    id: 'lavender',
    name: 'Dusk Violet',
    description: 'Muted twilight lavender',
    cssClass: 'wallpaper-lavender',
    defaultDoodle: true,
  },
  {
    id: 'sand',
    name: 'Warm Terracotta',
    description: 'Soft desert sandstone',
    cssClass: 'wallpaper-sand',
    defaultDoodle: true,
  },
  {
    id: 'minimal',
    name: 'Clean Solid',
    description: 'Distraction-free flat surface',
    cssClass: 'wallpaper-minimal',
    defaultDoodle: false,
  },
];

// ============================================================================
// Pure Storage & Formatting Utilities
// ============================================================================

function normalizeUserId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.#$\[\]/]/g, '_');
}

function pickAvatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function createEmptyStore(): AppStore {
  return {
    users: {},
    contacts: {},
    messages: [],
    activeSessions: {},
  };
}

function readStore(): AppStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createEmptyStore();
    const parsed = JSON.parse(raw) as Partial<AppStore>;
    return {
      users: parsed.users ?? {},
      contacts: parsed.contacts ?? {},
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      activeSessions: parsed.activeSessions ?? {},
    };
  } catch {
    return createEmptyStore();
  }
}

function getTabId(): string {
  let id = sessionStorage.getItem(TAB_ID_KEY);
  if (!id) {
    id = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    sessionStorage.setItem(TAB_ID_KEY, id);
  }
  return id;
}

const MAX_IMAGE_DIMENSION = 1080;

function compressCanvasToBase64(
  source: HTMLVideoElement | HTMLImageElement,
  naturalWidth: number,
  naturalHeight: number,
  mirror = false
): string {
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not acquire 2D canvas context.');
  }

  if (mirror) {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }

  ctx.drawImage(source, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', 0.78);
}

function fileToCompressedBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read selected image file.'));
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl) {
        reject(new Error('Empty image file.'));
        return;
      }
      const img = new Image();
      img.onerror = () => reject(new Error('Unsupported or corrupted image format.'));
      img.onload = () => {
        try {
          const compressed = compressCanvasToBase64(img, img.naturalWidth, img.naturalHeight, false);
          resolve(compressed);
        } catch (err) {
          reject(err);
        }
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

function isUserOnline(store: AppStore, userId: string, now = Date.now()): boolean {
  return Object.values(store.activeSessions).some(
    (s) => s.userId === userId && now - s.lastHeartbeat < SESSION_TIMEOUT_MS
  );
}

function isUserTypingTo(
  store: AppStore,
  senderId: string,
  recipientId: string,
  now = Date.now()
): boolean {
  return Object.values(store.activeSessions).some(
    (s) =>
      s.userId === senderId &&
      s.typingTo === recipientId &&
      now - s.lastHeartbeat < SESSION_TIMEOUT_MS
  );
}

function formatMessageTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatChatListTime(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;

  if (ts >= startOfToday) {
    return formatMessageTime(ts);
  }
  if (ts >= startOfYesterday) {
    return 'Yesterday';
  }
  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
  });
}

function formatDateSeparator(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;

  if (ts >= startOfToday) return 'Today';
  if (ts >= startOfYesterday) return 'Yesterday';
  return date.toLocaleDateString([], {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

function formatLastSeen(user: UserAccount, online: boolean): string {
  if (online) return 'Online';
  if (!user.isRegistered) return 'Not yet signed in';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;
  const timeStr = formatMessageTime(user.lastSeen);

  if (user.lastSeen >= startOfToday) {
    return `Last seen today at ${timeStr}`;
  }
  if (user.lastSeen >= startOfYesterday) {
    return `Last seen yesterday at ${timeStr}`;
  }
  const dateStr = new Date(user.lastSeen).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
  });
  return `Last seen ${dateStr} at ${timeStr}`;
}

// ============================================================================
// Avatar Component
// ============================================================================

function UserAvatar({
  name,
  color,
  size = 'md',
}: {
  name: string;
  color: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const sizeClass =
    size === 'sm'
      ? 'w-9 h-9 text-xs'
      : size === 'lg'
        ? 'w-12 h-12 text-base'
        : 'w-11 h-11 text-sm';

  return (
    <div
      className={`${sizeClass} rounded-full flex items-center justify-center font-semibold text-white shrink-0 select-none tracking-tight`}
      style={{ backgroundColor: color }}
      aria-hidden="true"
    >
      {getInitials(name)}
    </div>
  );
}

// ============================================================================
// Message Status Tick Component
// ============================================================================

function StatusTicks({ status, className = '' }: { status: MessageStatus; className?: string }) {
  if (status === 'sent') {
    return (
      <Check
        className={`w-3.5 h-3.5 text-[#667781] dark:text-[#8696A0] shrink-0 ${className}`}
        aria-label="Sent"
      />
    );
  }
  if (status === 'delivered') {
    return (
      <CheckCheck
        className={`w-4 h-4 text-[#667781] dark:text-[#8696A0] shrink-0 ${className}`}
        aria-label="Delivered"
      />
    );
  }
  return (
    <CheckCheck
      className={`w-4 h-4 text-[#53BDEB] shrink-0 ${className}`}
      aria-label="Read"
    />
  );
}

// ============================================================================
// Main Application Component (Single-File Implementation)
// ============================================================================

export default function App() {
  const [store, setStore] = useState<AppStore>(() => readStore());
  const [currentUserId, setCurrentUserId] = useState<string | null>(() => {
    const savedId = sessionStorage.getItem(SESSION_USER_KEY);
    if (!savedId) return null;
    const currentStore = readStore();
    return currentStore.users[savedId] ? savedId : null;
  });

  const [darkMode, setDarkMode] = useState<boolean>(() => {
    return localStorage.getItem(THEME_KEY) === 'dark';
  });

  // Auth / Login state
  const [loginName, setLoginName] = useState('');
  const [loginAbout, setLoginAbout] = useState('');
  const [loginError, setLoginError] = useState('');

  // Navigation & UI state
  const [activePeerId, setActivePeerId] = useState<string | null>(null);
  const [sidebarView, setSidebarView] = useState<
    'chats' | 'new-chat' | 'settings' | 'wallpaper'
  >('chats');
  const [aboutDraft, setAboutDraft] = useState('');
  const [editingAbout, setEditingAbout] = useState(false);
  const [chatSearch, setChatSearch] = useState('');
  const [isChatSearchFocused, setIsChatSearchFocused] = useState(false);
  const [chatFilter, setChatFilter] = useState<'all' | 'unread'>('all');
  const [directorySearch, setDirectorySearch] = useState('');
  const [isDirectorySearchFocused, setIsDirectorySearchFocused] = useState(false);
  const [showAddContactForm, setShowAddContactForm] = useState(false);
  const [newContactName, setNewContactName] = useState('');
  const [newContactNickname, setNewContactNickname] = useState('');
  const [contactError, setContactError] = useState('');

  // Active Chat Composer & Menus
  const [draftText, setDraftText] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showChatMenu, setShowChatMenu] = useState(false);
  const [inChatSearchOpen, setInChatSearchOpen] = useState(false);
  const [inChatSearchQuery, setInChatSearchQuery] = useState('');
  const [expandedReactionMsgId, setExpandedReactionMsgId] = useState<string | null>(null);
  const [unreadBannerState, setUnreadBannerState] = useState<{
    firstMessageId: string;
    count: number;
  } | null>(null);

  // Camera API & Image Sharing state
  const [cameraModalOpen, setCameraModalOpen] = useState(false);
  const [cameraFacingMode, setCameraFacingMode] = useState<'user' | 'environment'>('user');
  const [cameraStatus, setCameraStatus] = useState<'starting' | 'ready' | 'error'>('starting');
  const [cameraError, setCameraError] = useState('');
  const [capturedImageBase64, setCapturedImageBase64] = useState<string | null>(null);
  const [imageCaption, setImageCaption] = useState('');
  const [storageWarning, setStorageWarning] = useState('');
  const [lightboxImage, setLightboxImage] = useState<{
    src: string;
    caption: string;
    senderName: string;
    timestamp: number;
  } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const chatSearchInputRef = useRef<HTMLInputElement | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const cameraFileInputRef = useRef<HTMLInputElement | null>(null);
  const broadcastRef = useRef<BroadcastChannel | null>(null);
  const tabIdRef = useRef<string>(getTabId());
  const storeRef = useRef<AppStore>(store);
  const currentUserIdRef = useRef<string | null>(currentUserId);
  storeRef.current = store;
  currentUserIdRef.current = currentUserId;
  const isChatSearchExpanded = isChatSearchFocused || chatSearch.length > 0;
  const isDirectorySearchExpanded = isDirectorySearchFocused || directorySearch.length > 0;

  // Sync dark mode class on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
      localStorage.setItem(THEME_KEY, 'dark');
    } else {
      root.classList.remove('dark');
      localStorage.setItem(THEME_KEY, 'light');
    }
  }, [darkMode]);

  // Helper to atomically update state, localStorage & notify same-origin tabs
  const mutateStore = useCallback((mutator: (draft: AppStore) => AppStore | void) => {
    const latestLocal = readStore();
    const mem = storeRef.current;
    const latest: AppStore =
      Object.keys(mem.users).length > 0 || mem.messages.length > 0 ? mem : latestLocal;
    const cloned: AppStore = {
      users: { ...latest.users },
      contacts: { ...latest.contacts },
      messages: [...latest.messages],
      activeSessions: { ...latest.activeSessions },
    };
    const result = mutator(cloned) ?? cloned;
    storeRef.current = result;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(result));
      setStorageWarning('');
    } catch {
      setStorageWarning('Browser storage is full. Clear older conversations to continue saving photos locally.');
    }
    setStore(result);
    if (broadcastRef.current) {
      broadcastRef.current.postMessage({ type: 'STORE_UPDATED', at: Date.now() });
    }
    return result;
  }, []);

  // Setup multi-tab sync (BroadcastChannel + storage) & dedicated Firebase RTDB .on('value') / onValue listeners
  useEffect(() => {
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(CHANNEL_NAME);
      broadcastRef.current = channel;
      channel.onmessage = () => {
        const fresh = readStore();
        storeRef.current = fresh;
        setStore(fresh);
      };
    }

    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY || e.key === null) {
        const fresh = readStore();
        storeRef.current = fresh;
        setStore(fresh);
      }
    };
    window.addEventListener('storage', handleStorage);

    const persistSynced = (next: AppStore): AppStore => {
      storeRef.current = next;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Continue updating React state even if localStorage quota is reached
      }
      return next;
    };

    const unsubscribers: Array<() => void> = [];
    if (rtdb) {
      const usersRef = ref(rtdb, 'wa_messenger/users');
      const contactsRef = ref(rtdb, 'wa_messenger/contacts');
      const messagesRef = ref(rtdb, 'wa_messenger/messages');
      const sessionsRef = ref(rtdb, 'wa_messenger/activeSessions');

      unsubscribers.push(
        onValue(
          usersRef,
          (snapshot) => {
            const remoteUsers = (snapshot.val() ?? {}) as Record<string, UserAccount>;
            setStore((prev) => {
              const mergedUsers = { ...remoteUsers };
              const activeUid = currentUserIdRef.current;
              if (activeUid && prev.users[activeUid] && !mergedUsers[activeUid]) {
                mergedUsers[activeUid] = prev.users[activeUid];
              }
              return persistSynced({
                ...prev,
                users: mergedUsers,
              });
            });
          },
          (err) => console.warn('Firebase RTDB users listener warning:', err)
        )
      );

      unsubscribers.push(
        onValue(
          contactsRef,
          (snapshot) => {
            const remoteContacts = (snapshot.val() ?? {}) as Record<
              string,
              Record<string, ContactEntry>
            >;
            setStore((prev) =>
              persistSynced({
                ...prev,
                contacts: remoteContacts,
              })
            );
          },
          (err) => console.warn('Firebase RTDB contacts listener warning:', err)
        )
      );

      unsubscribers.push(
        onValue(
          messagesRef,
          (snapshot) => {
            const raw = (snapshot.val() ?? {}) as Record<string, MessageRecord>;
            const nextMessages = Object.values(raw)
              .map((m) => ({ ...m, text: m.text ?? '' }))
              .sort((a, b) => a.timestamp - b.timestamp);
            setStore((prev) =>
              persistSynced({
                ...prev,
                messages: nextMessages,
              })
            );
          },
          (err) => console.warn('Firebase RTDB messages listener warning:', err)
        )
      );

      unsubscribers.push(
        onValue(
          sessionsRef,
          (snapshot) => {
            const remoteSessions = (snapshot.val() ?? {}) as Record<string, ActiveSession>;
            setStore((prev) =>
              persistSynced({
                ...prev,
                activeSessions: remoteSessions,
              })
            );
          },
          (err) => console.warn('Firebase RTDB sessions listener warning:', err)
        )
      );
    }

    return () => {
      window.removeEventListener('storage', handleStorage);
      if (broadcastRef.current) {
        broadcastRef.current.close();
        broadcastRef.current = null;
      }
      for (const unsub of unsubscribers) {
        unsub();
      }
    };
  }, []);

  // Heartbeat & session cleanup for real online/offline & typing detection
  const typingTarget = activePeerId && draftText.length > 0 ? activePeerId : null;

  useEffect(() => {
    if (!currentUserId) return;
    const tabId = tabIdRef.current;

    if (rtdb) {
      const sessionRef = ref(rtdb, `wa_messenger/activeSessions/${toRtdbKey(tabId)}`);
      void onDisconnect(sessionRef).remove();
    }

    const beat = () => {
      const now = Date.now();
      const deliveredIds: string[] = [];

      const updated = mutateStore((draft) => {
        // Clean stale sessions
        for (const [sid, sess] of Object.entries(draft.activeSessions)) {
          if (now - sess.lastHeartbeat > SESSION_TIMEOUT_MS * 2) {
            delete draft.activeSessions[sid];
          }
        }
        draft.activeSessions[tabId] = {
          userId: currentUserId,
          lastHeartbeat: now,
          typingTo: typingTarget,
        };
        if (draft.users[currentUserId]) {
          draft.users[currentUserId] = {
            ...draft.users[currentUserId],
            lastSeen: now,
          };
        }

        // Upgrade any 'sent' messages addressed to currentUserId to 'delivered'
        draft.messages = draft.messages.map((msg) => {
          if (msg.recipientId === currentUserId && msg.status === 'sent') {
            deliveredIds.push(msg.id);
            return { ...msg, status: 'delivered' as MessageStatus };
          }
          return msg;
        });
        return draft;
      });

      if (rtdb) {
        void set(ref(rtdb, `wa_messenger/activeSessions/${toRtdbKey(tabId)}`), {
          userId: currentUserId,
          lastHeartbeat: now,
          typingTo: typingTarget,
        });
        if (updated.users[currentUserId]) {
          void update(ref(rtdb, `wa_messenger/users/${toRtdbKey(currentUserId)}`), {
            lastSeen: now,
          });
        }
        for (const msgId of deliveredIds) {
          void update(ref(rtdb, `wa_messenger/messages/${toRtdbKey(msgId)}`), {
            status: 'delivered',
          });
        }
      }
    };

    beat();
    const interval = window.setInterval(beat, 5000);

    const handleUnload = () => {
      const latest = readStore();
      delete latest.activeSessions[tabId];
      if (latest.users[currentUserId]) {
        latest.users[currentUserId].lastSeen = Date.now();
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(latest));
      if (broadcastRef.current) {
        broadcastRef.current.postMessage({ type: 'STORE_UPDATED', at: Date.now() });
      }
      if (rtdb) {
        void remove(ref(rtdb, `wa_messenger/activeSessions/${toRtdbKey(tabId)}`));
      }
    };

    window.addEventListener('beforeunload', handleUnload);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('beforeunload', handleUnload);
    };
  }, [currentUserId, typingTarget, mutateStore]);

  // Mark incoming messages as 'read' when activePeerId is open
  useEffect(() => {
    if (!currentUserId || !activePeerId) return;

    const unreadIds = store.messages
      .filter(
        (m) =>
          m.senderId === activePeerId &&
          m.recipientId === currentUserId &&
          m.status !== 'read'
      )
      .map((m) => m.id);

    if (unreadIds.length > 0) {
      mutateStore((draft) => {
        draft.messages = draft.messages.map((m) => {
          if (
            m.senderId === activePeerId &&
            m.recipientId === currentUserId &&
            m.status !== 'read'
          ) {
            return { ...m, status: 'read' };
          }
          return m;
        });
      });

      if (rtdb) {
        for (const msgId of unreadIds) {
          void update(ref(rtdb, `wa_messenger/messages/${toRtdbKey(msgId)}`), {
            status: 'read',
          });
        }
      }
    }
  }, [currentUserId, activePeerId, store.messages, mutateStore]);

  // Auto-scroll to bottom when active conversation messages change
  const activeConversationMessages = useMemo(() => {
    if (!currentUserId || !activePeerId) return [];
    return store.messages
      .filter(
        (m) =>
          (m.senderId === currentUserId && m.recipientId === activePeerId) ||
          (m.senderId === activePeerId && m.recipientId === currentUserId)
      )
      .sort((a, b) => a.timestamp - b.timestamp);
  }, [store.messages, currentUserId, activePeerId]);

  useEffect(() => {
    if (activePeerId && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activePeerId, activeConversationMessages.length]);

  // Current user object
  const currentUser = currentUserId ? store.users[currentUserId] ?? null : null;

  // Previously registered accounts on this device (strictly real users, empty on fresh start)
  const registeredAccounts = useMemo(() => {
    return Object.values(store.users)
      .filter((u) => u.isRegistered)
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }, [store.users]);

  // Display name helper respecting custom contact nicknames
  const getPeerDisplayName = useCallback(
    (peerId: string): string => {
      if (!currentUserId) return peerId;
      const contact = store.contacts[currentUserId]?.[peerId];
      if (contact?.nickname && contact.nickname.trim()) {
        return contact.nickname.trim();
      }
      return store.users[peerId]?.displayName ?? peerId;
    },
    [currentUserId, store.contacts, store.users]
  );

  // Build active chat summaries (ONLY conversations that actually have messages, plus currently open new chat if desired)
  const chatList = useMemo(() => {
    if (!currentUserId) return [];

    const byPeer: Record<
      string,
      {
        peerId: string;
        lastMessage: MessageRecord | null;
        unreadCount: number;
      }
    > = {};

    for (const msg of store.messages) {
      if (msg.senderId !== currentUserId && msg.recipientId !== currentUserId) continue;
      const peerId: string = msg.senderId === currentUserId ? msg.recipientId : msg.senderId;
      if (peerId === currentUserId) continue;

      if (!byPeer[peerId]) {
        byPeer[peerId] = { peerId, lastMessage: null, unreadCount: 0 };
      }

      const existing = byPeer[peerId].lastMessage;
      if (!existing || msg.timestamp >= existing.timestamp) {
        byPeer[peerId].lastMessage = msg;
      }

      if (msg.recipientId === currentUserId && msg.senderId === peerId && msg.status !== 'read') {
        byPeer[peerId].unreadCount += 1;
      }
    }

    let list = Object.values(byPeer).sort((a, b) => {
      const ta = a.lastMessage?.timestamp ?? 0;
      const tb = b.lastMessage?.timestamp ?? 0;
      return tb - ta;
    });

    if (chatFilter === 'unread') {
      list = list.filter((c) => c.unreadCount > 0);
    }

    const q = chatSearch.trim().toLowerCase();
    if (q) {
      list = list.filter((c) => {
        const name = getPeerDisplayName(c.peerId).toLowerCase();
        const preview = c.lastMessage?.text.toLowerCase() ?? '';
        const hasPhotoMatch = Boolean(c.lastMessage?.imageBase64) && 'photo'.includes(q);
        return name.includes(q) || preview.includes(q) || hasPhotoMatch;
      });
    }

    return list;
  }, [store.messages, currentUserId, chatFilter, chatSearch, getPeerDisplayName]);

  const totalUnreadChats = useMemo(() => {
    if (!currentUserId) return 0;
    const unreadPeers = new Set<string>();
    for (const msg of store.messages) {
      if (msg.recipientId === currentUserId && msg.status !== 'read') {
        unreadPeers.add(msg.senderId);
      }
    }
    return unreadPeers.size;
  }, [store.messages, currentUserId]);

  // Directory: Saved Contacts + Other Registered Users
  const myContactsList = useMemo(() => {
    if (!currentUserId) return [];
    const map = store.contacts[currentUserId] ?? {};
    const q = directorySearch.trim().toLowerCase();
    return Object.values(map)
      .map((entry) => ({
        entry,
        user: store.users[entry.userId],
        label: getPeerDisplayName(entry.userId),
      }))
      .filter((item) => Boolean(item.user))
      .filter((item) => !q || item.label.toLowerCase().includes(q) || item.user.displayName.toLowerCase().includes(q))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [currentUserId, store.contacts, store.users, directorySearch, getPeerDisplayName]);

  const otherRegisteredUsers = useMemo(() => {
    if (!currentUserId) return [];
    const q = directorySearch.trim().toLowerCase();
    const contactMap = store.contacts[currentUserId] ?? {};
    return Object.values(store.users)
      .filter((u) => u.id !== currentUserId && u.isRegistered && !contactMap[u.id])
      .filter((u) => !q || u.displayName.toLowerCase().includes(q) || u.id.includes(q))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [currentUserId, store.users, store.contacts, directorySearch]);

  // ============================================================================
  // Handlers
  // ============================================================================

  const handleLoginSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const rawName = loginName.trim();
    if (!rawName) {
      setLoginError('Please enter your name to continue.');
      return;
    }
    if (rawName.length < 2) {
      setLoginError('Name must be at least 2 characters.');
      return;
    }

    const userId = normalizeUserId(rawName);
    const now = Date.now();
    const tabId = tabIdRef.current;

    const nextStore = mutateStore((draft) => {
      const existing = draft.users[userId];
      if (existing) {
        draft.users[userId] = {
          ...existing,
          displayName: existing.isRegistered ? existing.displayName : rawName,
          about: loginAbout.trim() || existing.about || 'Available',
          isRegistered: true,
          lastSeen: now,
        };
      } else {
        draft.users[userId] = {
          id: userId,
          displayName: rawName,
          about: loginAbout.trim() || 'Available',
          avatarColor: pickAvatarColor(userId),
          isRegistered: true,
          createdAt: now,
          lastSeen: now,
        };
      }

      draft.activeSessions[tabId] = { userId, lastHeartbeat: now };

      // Mark any offline 'sent' messages waiting for this user as 'delivered'
      draft.messages = draft.messages.map((m) =>
        m.recipientId === userId && m.status === 'sent'
          ? { ...m, status: 'delivered' }
          : m
      );
    });

    if (rtdb && nextStore.users[userId]) {
      void set(ref(rtdb, `wa_messenger/users/${toRtdbKey(userId)}`), nextStore.users[userId]);
      void set(ref(rtdb, `wa_messenger/activeSessions/${toRtdbKey(tabId)}`), {
        userId,
        lastHeartbeat: now,
        typingTo: null,
      });
    }

    sessionStorage.setItem(SESSION_USER_KEY, userId);
    setCurrentUserId(userId);
    setActivePeerId(null);
    setSidebarView('chats');
    setLoginName('');
    setLoginAbout('');
    setLoginError('');
  };

  const handleQuickLogin = (userId: string) => {
    const now = Date.now();
    const tabId = tabIdRef.current;

    const nextStore = mutateStore((draft) => {
      const user = draft.users[userId];
      if (!user) return;
      draft.users[userId] = {
        ...user,
        isRegistered: true,
        lastSeen: now,
      };
      draft.activeSessions[tabId] = { userId, lastHeartbeat: now };
      draft.messages = draft.messages.map((m) =>
        m.recipientId === userId && m.status === 'sent'
          ? { ...m, status: 'delivered' }
          : m
      );
    });

    if (rtdb && nextStore.users[userId]) {
      void set(ref(rtdb, `wa_messenger/users/${toRtdbKey(userId)}`), nextStore.users[userId]);
      void set(ref(rtdb, `wa_messenger/activeSessions/${toRtdbKey(tabId)}`), {
        userId,
        lastHeartbeat: now,
        typingTo: null,
      });
    }

    sessionStorage.setItem(SESSION_USER_KEY, userId);
    setCurrentUserId(userId);
    setActivePeerId(null);
    setSidebarView('chats');
    setLoginError('');
  };

  const handleLogout = () => {
    if (!currentUserId) return;
    const tabId = tabIdRef.current;
    const exitingUserId = currentUserId;
    const now = Date.now();

    mutateStore((draft) => {
      delete draft.activeSessions[tabId];
      if (draft.users[exitingUserId]) {
        draft.users[exitingUserId] = {
          ...draft.users[exitingUserId],
          lastSeen: now,
        };
      }
    });

    if (rtdb) {
      void remove(ref(rtdb, `wa_messenger/activeSessions/${toRtdbKey(tabId)}`));
      void update(ref(rtdb, `wa_messenger/users/${toRtdbKey(exitingUserId)}`), {
        lastSeen: now,
      });
    }

    sessionStorage.removeItem(SESSION_USER_KEY);
    setCurrentUserId(null);
    setActivePeerId(null);
    setSidebarView('chats');
    setDraftText('');
    setShowEmojiPicker(false);
    setShowChatMenu(false);
    setInChatSearchOpen(false);
    setInChatSearchQuery('');
    setCameraModalOpen(false);
    setCapturedImageBase64(null);
    setLightboxImage(null);
  };

  const handleOpenChat = (peerId: string) => {
    if (!currentUserId || peerId === currentUserId) return;

    // Capture unread messages before opening so we can anchor the transient unread divider
    const unreadMessages = store.messages
      .filter((m) => m.senderId === peerId && m.recipientId === currentUserId && m.status !== 'read')
      .sort((a, b) => a.timestamp - b.timestamp);

    setUnreadBannerState(
      unreadMessages.length > 0
        ? { firstMessageId: unreadMessages[0].id, count: unreadMessages.length }
        : null
    );
    setActivePeerId(peerId);
    setSidebarView('chats');
    setShowChatMenu(false);
    setShowEmojiPicker(false);
    setInChatSearchOpen(false);
    setInChatSearchQuery('');
    setCameraModalOpen(false);
    setCapturedImageBase64(null);
    setLightboxImage(null);

    window.setTimeout(() => {
      textareaRef.current?.focus();
    }, 50);
  };

  const handleAddContact = (e: React.FormEvent, startChatAfter = true) => {
    e.preventDefault();
    if (!currentUserId) return;

    const rawName = newContactName.trim();
    if (!rawName) {
      setContactError('Enter a contact name.');
      return;
    }

    const peerId = normalizeUserId(rawName);
    if (peerId === currentUserId) {
      setContactError('You cannot add yourself as a contact.');
      return;
    }

    const now = Date.now();
    const nextStore = mutateStore((draft) => {
      if (!draft.users[peerId]) {
        draft.users[peerId] = {
          id: peerId,
          displayName: rawName,
          about: 'Available',
          avatarColor: pickAvatarColor(peerId),
          isRegistered: false,
          createdAt: now,
          lastSeen: now,
        };
      }

      if (!draft.contacts[currentUserId]) {
        draft.contacts[currentUserId] = {};
      }
      draft.contacts[currentUserId][peerId] = {
        userId: peerId,
        nickname: newContactNickname.trim() || undefined,
        addedAt: now,
      };
    });

    if (rtdb) {
      if (nextStore.users[peerId]) {
        void set(ref(rtdb, `wa_messenger/users/${toRtdbKey(peerId)}`), nextStore.users[peerId]);
      }
      const contactRecord = nextStore.contacts[currentUserId]?.[peerId];
      if (contactRecord) {
        const cleanContact: ContactEntry = {
          userId: contactRecord.userId,
          addedAt: contactRecord.addedAt,
          ...(contactRecord.nickname ? { nickname: contactRecord.nickname } : {}),
        };
        void set(
          ref(rtdb, `wa_messenger/contacts/${toRtdbKey(currentUserId)}/${toRtdbKey(peerId)}`),
          cleanContact
        );
      }
    }

    setNewContactName('');
    setNewContactNickname('');
    setContactError('');
    setShowAddContactForm(false);

    if (startChatAfter) {
      handleOpenChat(peerId);
    }
  };

  const dispatchChatMessage = (textValue: string, imageBase64?: string) => {
    if (!currentUserId || !activePeerId) return;
    const text = textValue.trim();
    if (!text && !imageBase64) return;

    const now = Date.now();
    let createdMsg: MessageRecord | null = null;

    const peerExistedBefore = Boolean(storeRef.current.users[activePeerId]);
    const nextStore = mutateStore((draft) => {
      // Ensure peer user record exists
      if (!draft.users[activePeerId]) {
        draft.users[activePeerId] = {
          id: activePeerId,
          displayName: activePeerId,
          about: 'Available',
          avatarColor: pickAvatarColor(activePeerId),
          isRegistered: false,
          createdAt: now,
          lastSeen: now,
        };
      }

      const recipientOnline = isUserOnline(draft, activePeerId, now);
      const createdMsgId = `msg_${now}_${Math.random().toString(36).slice(2, 8)}`;

      createdMsg = {
        id: createdMsgId,
        senderId: currentUserId,
        recipientId: activePeerId,
        text,
        ...(imageBase64 ? { imageBase64 } : {}),
        timestamp: now,
        status: recipientOnline ? 'delivered' : 'sent',
      };

      draft.messages.push(createdMsg);

      const tabId = tabIdRef.current;
      if (draft.activeSessions[tabId]) {
        draft.activeSessions[tabId] = {
          ...draft.activeSessions[tabId],
          lastHeartbeat: now,
          typingTo: null,
        };
      }
    });

    if (rtdb && createdMsg) {
      const msgToSave = createdMsg as MessageRecord;
      if (nextStore.users[currentUserId]) {
        void set(
          ref(rtdb, `wa_messenger/users/${toRtdbKey(currentUserId)}`),
          nextStore.users[currentUserId]
        );
      }
      if (!peerExistedBefore && nextStore.users[activePeerId]) {
        void set(
          ref(rtdb, `wa_messenger/users/${toRtdbKey(activePeerId)}`),
          nextStore.users[activePeerId]
        );
      }
      void set(ref(rtdb, `wa_messenger/messages/${toRtdbKey(msgToSave.id)}`), msgToSave);
      void update(ref(rtdb, `wa_messenger/activeSessions/${toRtdbKey(tabIdRef.current)}`), {
        lastHeartbeat: now,
        typingTo: null,
      });
    }

    setUnreadBannerState(null);
  };

  const handleSendMessage = () => {
    if (!draftText.trim()) return;
    dispatchChatMessage(draftText);
    setDraftText('');
    setShowEmojiPicker(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const stopCameraStream = useCallback(() => {
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
    }
    if (cameraVideoRef.current) {
      cameraVideoRef.current.srcObject = null;
    }
  }, []);

  // Manage live MediaDevices Camera stream while Camera modal is open & in viewfinder mode
  useEffect(() => {
    if (!cameraModalOpen || capturedImageBase64) {
      stopCameraStream();
      return;
    }

    let cancelled = false;

    const startCamera = async () => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setCameraStatus('error');
        setCameraError(
          'Camera API is not available in this browser context. You can still upload or capture an image below.'
        );
        return;
      }

      setCameraStatus('starting');
      setCameraError('');
      stopCameraStream();

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: cameraFacingMode },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        cameraStreamRef.current = stream;
        if (cameraVideoRef.current) {
          cameraVideoRef.current.srcObject = stream;
          await cameraVideoRef.current.play().catch(() => {});
        }
        setCameraStatus('ready');
      } catch (err) {
        if (cancelled) return;
        const message =
          err instanceof DOMException && err.name === 'NotAllowedError'
            ? 'Camera permission was denied. Allow camera access in your browser or choose a photo from your device below.'
            : err instanceof DOMException && err.name === 'NotFoundError'
            ? 'No camera device was detected. You can select or take a photo using your device picker below.'
            : 'Unable to access the camera right now. Try allowing camera permission or choose a photo below.';
        setCameraStatus('error');
        setCameraError(message);
      }
    };

    void startCamera();

    return () => {
      cancelled = true;
      stopCameraStream();
    };
  }, [cameraModalOpen, cameraFacingMode, capturedImageBase64, stopCameraStream]);

  const handleOpenCameraModal = () => {
    setShowEmojiPicker(false);
    setShowChatMenu(false);
    setCapturedImageBase64(null);
    setImageCaption(draftText);
    setCameraError('');
    setCameraModalOpen(true);
  };

  const handleCloseCameraModal = () => {
    stopCameraStream();
    setCameraModalOpen(false);
    setCapturedImageBase64(null);
    setCameraError('');
  };

  const handleCapturePhoto = () => {
    const video = cameraVideoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;

    try {
      const base64 = compressCanvasToBase64(
        video,
        video.videoWidth,
        video.videoHeight,
        cameraFacingMode === 'user'
      );
      stopCameraStream();
      setCapturedImageBase64(base64);
    } catch {
      setCameraError('Could not capture frame from camera. Please try again.');
    }
  };

  const handleFallbackFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    try {
      const base64 = await fileToCompressedBase64(file);
      stopCameraStream();
      setCapturedImageBase64(base64);
      setCameraError('');
    } catch {
      setCameraError('Could not process that image file. Please select another photo.');
    }
  };

  const handleSendCapturedImage = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!capturedImageBase64) return;
    dispatchChatMessage(imageCaption, capturedImageBase64);
    setDraftText('');
    setImageCaption('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    handleCloseCameraModal();
  };

  const handleClearConversation = () => {
    if (!currentUserId || !activePeerId) return;
    const idsToDelete = store.messages
      .filter(
        (m) =>
          (m.senderId === currentUserId && m.recipientId === activePeerId) ||
          (m.senderId === activePeerId && m.recipientId === currentUserId)
      )
      .map((m) => m.id);

    mutateStore((draft) => {
      draft.messages = draft.messages.filter(
        (m) =>
          !(
            (m.senderId === currentUserId && m.recipientId === activePeerId) ||
            (m.senderId === activePeerId && m.recipientId === currentUserId)
          )
      );
    });

    if (rtdb) {
      for (const id of idsToDelete) {
        void remove(ref(rtdb, `wa_messenger/messages/${toRtdbKey(id)}`));
      }
    }
    setShowChatMenu(false);
  };

  const handleToggleReaction = (messageId: string, emoji: string) => {
    if (!currentUserId) return;
    let updatedReactions: Record<string, string> | undefined;

    mutateStore((draft) => {
      draft.messages = draft.messages.map((m) => {
        if (m.id !== messageId) return m;
        const nextReactions: Record<string, string> = { ...(m.reactions ?? {}) };
        if (nextReactions[currentUserId] === emoji) {
          delete nextReactions[currentUserId];
        } else {
          nextReactions[currentUserId] = emoji;
        }
        updatedReactions = Object.keys(nextReactions).length > 0 ? nextReactions : undefined;
        return {
          ...m,
          reactions: updatedReactions,
        };
      });
    });

    if (rtdb) {
      void update(ref(rtdb, `wa_messenger/messages/${toRtdbKey(messageId)}`), {
        reactions: updatedReactions ?? null,
      });
    }
    setExpandedReactionMsgId(null);
  };

  const handleSelectWallpaper = (theme: WallpaperTheme) => {
    if (!currentUserId) return;
    mutateStore((draft) => {
      const existing = draft.users[currentUserId];
      if (!existing) return;
      draft.users[currentUserId] = {
        ...existing,
        wallpaper: theme.id,
        wallpaperDoodle: theme.defaultDoodle,
      };
    });
    if (rtdb) {
      void update(ref(rtdb, `wa_messenger/users/${toRtdbKey(currentUserId)}`), {
        wallpaper: theme.id,
        wallpaperDoodle: theme.defaultDoodle,
      });
    }
  };

  const handleToggleWallpaperDoodle = () => {
    if (!currentUserId) return;
    let nextDoodle = true;
    mutateStore((draft) => {
      const existing = draft.users[currentUserId];
      if (!existing) return;
      const currentDoodle = existing.wallpaperDoodle ?? true;
      nextDoodle = !currentDoodle;
      draft.users[currentUserId] = {
        ...existing,
        wallpaperDoodle: nextDoodle,
      };
    });
    if (rtdb) {
      void update(ref(rtdb, `wa_messenger/users/${toRtdbKey(currentUserId)}`), {
        wallpaperDoodle: nextDoodle,
      });
    }
  };

  const handleSaveAbout = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUserId) return;
    const nextAbout = aboutDraft.trim() || 'Available';
    mutateStore((draft) => {
      const existing = draft.users[currentUserId];
      if (!existing) return;
      draft.users[currentUserId] = {
        ...existing,
        about: nextAbout,
      };
    });
    if (rtdb) {
      void update(ref(rtdb, `wa_messenger/users/${toRtdbKey(currentUserId)}`), {
        about: nextAbout,
      });
    }
    setEditingAbout(false);
  };

  const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraftText(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  const activePeer: UserAccount | null = activePeerId
    ? store.users[activePeerId] ?? {
        id: activePeerId,
        displayName: getPeerDisplayName(activePeerId),
        about: 'Available',
        avatarColor: pickAvatarColor(activePeerId),
        isRegistered: true,
        createdAt: Date.now(),
        lastSeen: Date.now(),
      }
    : null;
  const activePeerOnline = activePeerId ? isUserOnline(store, activePeerId) : false;
  const activePeerTyping =
    currentUserId && activePeerId
      ? isUserTypingTo(store, activePeerId, currentUserId)
      : false;

  const activeWallpaperId: WallpaperId = currentUser?.wallpaper ?? 'classic';
  const activeWallpaper =
    WALLPAPER_THEMES.find((t) => t.id === activeWallpaperId) ?? WALLPAPER_THEMES[0];
  const activeWallpaperDoodle =
    currentUser?.wallpaperDoodle ?? activeWallpaper.defaultDoodle;

  const filteredConversationMessages = useMemo(() => {
    const q = inChatSearchQuery.trim().toLowerCase();
    if (!q) return activeConversationMessages;
    return activeConversationMessages.filter(
      (m) =>
        m.text.toLowerCase().includes(q) ||
        (Boolean(m.imageBase64) && 'photo'.includes(q))
    );
  }, [activeConversationMessages, inChatSearchQuery]);

  // ============================================================================
  // Render: Authentication / Login Screen
  // ============================================================================

  if (!currentUser) {
    return (
      <div className="min-h-dvh bg-[#EAE6DF] dark:bg-[#0B141A] flex flex-col transition-colors">
        {/* Classic WhatsApp Web emerald top band */}
        <div className="h-44 sm:h-52 bg-[#00A884] dark:bg-[#005C4B] w-full shrink-0">
          <div className="max-w-4xl mx-auto px-6 pt-8 flex items-center justify-between">
            <div className="flex items-center gap-3 text-white">
              <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center">
                <MessageSquare className="w-5 h-5 text-white" />
              </div>
              <span className="text-lg font-semibold tracking-tight whitespace-nowrap">
                WhatsApp Web
              </span>
            </div>
            <button
              type="button"
              onClick={() => setDarkMode((d) => !d)}
              className="min-w-[44px] min-h-[44px] rounded-full flex items-center justify-center text-white/90 hover:bg-white/15 transition-colors focus-visible:outline-2 focus-visible:outline-white"
              aria-label={darkMode ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              {darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {/* Main Auth Card overlapping the emerald band */}
        <div className="flex-1 px-4 -mt-24 sm:-mt-28 pb-10 flex items-start justify-center">
          <div className="w-full max-w-xl bg-white dark:bg-[#202C33] rounded-xl shadow-lg border border-[#E9EDEF] dark:border-[#2A3942] p-6 sm:p-10">
            <div className="mb-7">
              <h1 className="text-2xl sm:text-3xl font-semibold text-[#111B21] dark:text-[#E9EDEF] tracking-tight">
                Sign in or create your account
              </h1>
              <p className="mt-2 text-sm sm:text-base text-[#54656F] dark:text-[#8696A0] leading-relaxed">
                Enter your name to start messaging. Chats, contacts, and unread messages sent while you are offline persist locally in this browser.
              </p>
            </div>

            <form onSubmit={handleLoginSubmit} className="space-y-5">
              <div>
                <label
                  htmlFor="login-name"
                  className="block text-sm font-medium text-[#111B21] dark:text-[#E9EDEF] mb-1.5"
                >
                  Your Name
                </label>
                <input
                  id="login-name"
                  type="text"
                  autoFocus
                  value={loginName}
                  onChange={(e) => {
                    setLoginName(e.target.value);
                    if (loginError) setLoginError('');
                  }}
                  placeholder="e.g., Shefasin"
                  maxLength={40}
                  className="w-full h-12 px-4 rounded-lg bg-[#F0F2F5] dark:bg-[#2A3942] text-[#111B21] dark:text-[#E9EDEF] placeholder-[#667781] dark:placeholder-[#8696A0] border border-transparent focus:border-[#00A884] focus:bg-white dark:focus:bg-[#2A3942] focus:outline-none transition-colors text-base"
                />
                {loginError && (
                  <p className="mt-1.5 text-xs font-medium text-[#DC2626] dark:text-[#F87171]">
                    {loginError}
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor="login-about"
                  className="block text-sm font-medium text-[#111B21] dark:text-[#E9EDEF] mb-1.5"
                >
                  Status line <span className="text-[#667781] dark:text-[#8696A0] font-normal">(optional)</span>
                </label>
                <input
                  id="login-about"
                  type="text"
                  value={loginAbout}
                  onChange={(e) => setLoginAbout(e.target.value)}
                  placeholder="Available"
                  maxLength={70}
                  className="w-full h-11 px-4 rounded-lg bg-[#F0F2F5] dark:bg-[#2A3942] text-[#111B21] dark:text-[#E9EDEF] placeholder-[#667781] dark:placeholder-[#8696A0] border border-transparent focus:border-[#00A884] focus:bg-white dark:focus:bg-[#2A3942] focus:outline-none transition-colors text-sm"
                />
              </div>

              <button
                type="submit"
                className="w-full h-12 rounded-lg bg-[#00A884] hover:bg-[#008F72] active:scale-[0.99] text-white font-semibold text-sm sm:text-base transition-all cursor-pointer whitespace-nowrap"
              >
                Continue to WhatsApp Web
              </button>
            </form>

            {/* Real previously registered accounts (never pre-filled fake users) */}
            {registeredAccounts.length > 0 && (
              <div className="mt-8 pt-6 border-t border-[#E9EDEF] dark:border-[#2A3942]">
                <h2 className="text-xs font-semibold text-[#54656F] dark:text-[#8696A0] tracking-wide mb-3">
                  Registered accounts on this browser
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {registeredAccounts.map((acc) => {
                    const unreadCount = store.messages.filter(
                      (m) => m.recipientId === acc.id && m.status !== 'read'
                    ).length;
                    return (
                      <button
                        key={acc.id}
                        type="button"
                        onClick={() => handleQuickLogin(acc.id)}
                        className="flex items-center gap-3 p-2.5 rounded-lg border border-[#E9EDEF] dark:border-[#2A3942] hover:bg-[#F5F6F6] dark:hover:bg-[#2A3942] transition-colors text-left cursor-pointer min-h-[56px]"
                      >
                        <UserAvatar name={acc.displayName} color={acc.avatarColor} size="sm" />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-[#111B21] dark:text-[#E9EDEF] truncate">
                            {acc.displayName}
                          </div>
                          <div className="text-xs text-[#667781] dark:text-[#8696A0] truncate">
                            {unreadCount > 0
                              ? `${unreadCount} unread message${unreadCount > 1 ? 's' : ''}`
                              : acc.about}
                          </div>
                        </div>
                        {unreadCount > 0 && (
                          <span className="w-5 h-5 rounded-full bg-[#00A884] text-white text-[11px] font-semibold flex items-center justify-center font-mono-tabular shrink-0">
                            {unreadCount}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="mt-7 pt-5 border-t border-[#E9EDEF] dark:border-[#2A3942] flex items-center gap-2 text-xs text-[#667781] dark:text-[#8696A0]">
              <Lock className="w-3.5 h-3.5 shrink-0" />
              <span>Messages are stored locally in your browser&apos;s LocalStorage across sessions and tabs.</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ============================================================================
  // Render: Main WhatsApp Web Layout
  // ============================================================================

  return (
    <MotionConfig reducedMotion="user">
    <div className="h-dvh w-screen overflow-hidden bg-[#EAE6DF] dark:bg-[#0B141A] flex flex-col md:p-3 lg:p-4 transition-colors">
      {/* Main Split Workspace */}
      <div className="flex-1 w-full max-w-[1600px] mx-auto bg-white dark:bg-[#111B21] md:rounded-xl md:shadow-md md:border border-[#D1D7DB] dark:border-[#222E35] flex overflow-hidden min-h-0">
        {/* ================================================================== */}
        {/* LEFT SIDEBAR: Chat List OR New Chat / Directory                    */}
        {/* ================================================================== */}
        <aside
          className={`${
            activePeerId ? 'hidden md:flex' : 'flex'
          } flex-col w-full md:w-[350px] lg:w-[400px] shrink-0 border-r border-[#E9EDEF] dark:border-[#222E35] bg-white dark:bg-[#111B21] min-h-0`}
        >
          {sidebarView === 'chats' ? (
            <>
              {/* Sidebar Top Header */}
              <header className="h-[60px] px-3 bg-[#F0F2F5] dark:bg-[#202C33] flex items-center justify-between gap-2 shrink-0 border-b border-[#E9EDEF] dark:border-[#222E35]">
                <button
                  type="button"
                  onClick={() => {
                    setAboutDraft(currentUser.about);
                    setEditingAbout(false);
                    setSidebarView('settings');
                  }}
                  title="Open application settings"
                  aria-label="Open application settings"
                  className="flex items-center gap-2.5 min-w-0 flex-1 text-left px-2 py-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer min-h-[44px]"
                >
                  <UserAvatar
                    name={currentUser.displayName}
                    color={currentUser.avatarColor}
                    size="sm"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-[#111B21] dark:text-[#E9EDEF] truncate">
                      {currentUser.displayName}
                    </div>
                    <div className="text-xs text-[#667781] dark:text-[#8696A0] truncate">
                      {currentUser.about}
                    </div>
                  </div>
                  <Settings className="w-4 h-4 text-[#54656F] dark:text-[#AEBAC1] shrink-0" />
                </button>

                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      setSidebarView('new-chat');
                      setDirectorySearch('');
                      setShowAddContactForm(false);
                    }}
                    title="New chat or add contact"
                    aria-label="New chat or add contact"
                    className="min-w-[44px] min-h-[44px] rounded-full flex items-center justify-center text-[#54656F] dark:text-[#AEBAC1] hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
                  >
                    <MessageSquarePlus className="w-5 h-5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDarkMode((d) => !d)}
                    title={darkMode ? 'Light mode' : 'Dark mode'}
                    aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
                    className="min-w-[44px] min-h-[44px] rounded-full flex items-center justify-center text-[#54656F] dark:text-[#AEBAC1] hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
                  >
                    {darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
                  </button>
                  <button
                    type="button"
                    onClick={handleLogout}
                    title="Log out / Switch user"
                    aria-label="Log out"
                    className="min-w-[44px] min-h-[44px] rounded-full flex items-center justify-center text-[#54656F] dark:text-[#AEBAC1] hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
                  >
                    <LogOut className="w-5 h-5" />
                  </button>
                </div>
              </header>

              {/* Animated Search & Filter Bar */}
              <div className="px-3 py-2.5 bg-white dark:bg-[#111B21] border-b border-[#E9EDEF] dark:border-[#222E35] shrink-0">
                <div className="flex items-center">
                  <motion.div
                    layout
                    animate={{
                      height: isChatSearchExpanded ? 42 : 36,
                    }}
                    transition={{
                      type: 'spring',
                      stiffness: 440,
                      damping: 32,
                      mass: 0.8,
                    }}
                    className={`relative flex-1 min-w-0 flex items-center rounded-lg transition-colors ${
                      isChatSearchExpanded
                        ? 'bg-white dark:bg-[#2A3942] ring-1 ring-[#00A884] shadow-sm'
                        : 'bg-[#F0F2F5] dark:bg-[#202C33] ring-1 ring-transparent'
                    }`}
                  >
                    <div className="absolute left-2.5 w-6 h-6 flex items-center justify-center">
                      <AnimatePresence mode="wait" initial={false}>
                        {isChatSearchExpanded ? (
                          <motion.button
                            key="search-back"
                            type="button"
                            initial={{ opacity: 0, rotate: -45, scale: 0.8 }}
                            animate={{ opacity: 1, rotate: 0, scale: 1 }}
                            exit={{ opacity: 0, rotate: -45, scale: 0.8 }}
                            transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              setChatSearch('');
                              setIsChatSearchFocused(false);
                              chatSearchInputRef.current?.blur();
                            }}
                            aria-label="Collapse search"
                            className="w-6 h-6 rounded-full flex items-center justify-center text-[#00A884] hover:bg-[#00A884]/10 cursor-pointer"
                          >
                            <ArrowLeft className="w-4 h-4" />
                          </motion.button>
                        ) : (
                          <motion.div
                            key="search-icon"
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.8 }}
                            transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                            className="flex items-center justify-center text-[#54656F] dark:text-[#8696A0] pointer-events-none"
                          >
                            <Search className="w-4 h-4" />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    <input
                      ref={chatSearchInputRef}
                      type="text"
                      value={chatSearch}
                      onFocus={() => setIsChatSearchFocused(true)}
                      onBlur={() => setIsChatSearchFocused(false)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          if (chatSearch) {
                            setChatSearch('');
                          } else {
                            setIsChatSearchFocused(false);
                            chatSearchInputRef.current?.blur();
                          }
                        }
                      }}
                      onChange={(e) => setChatSearch(e.target.value)}
                      placeholder={
                        isChatSearchExpanded
                          ? chatFilter === 'unread'
                            ? 'Search unread chats or messages...'
                            : 'Search chats or messages'
                          : chatFilter === 'unread'
                          ? 'Search unread...'
                          : 'Search chats'
                      }
                      aria-label="Search chats or messages"
                      className="w-full h-full pl-10 pr-8 bg-transparent text-sm text-[#111B21] dark:text-[#E9EDEF] placeholder-[#667781] dark:placeholder-[#8696A0] focus:outline-none"
                    />

                    <AnimatePresence initial={false}>
                      {chatSearch && (
                        <motion.button
                          key="clear-chat-search"
                          type="button"
                          initial={{ opacity: 0, scale: 0.7 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.7 }}
                          transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setChatSearch('');
                            chatSearchInputRef.current?.focus();
                          }}
                          aria-label="Clear search"
                          className="absolute right-2 p-1 rounded-full text-[#667781] hover:text-[#111B21] dark:hover:text-[#E9EDEF] hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
                        >
                          <X className="w-4 h-4" />
                        </motion.button>
                      )}
                    </AnimatePresence>
                  </motion.div>

                  {/* Interactive Filter Tabs (collapse smoothly when search expands) */}
                  <AnimatePresence initial={false}>
                    {!isChatSearchExpanded && (
                      <motion.div
                        key="chat-filter-tabs"
                        initial={{ opacity: 0, width: 0, marginLeft: 0 }}
                        animate={{ opacity: 1, width: 'auto', marginLeft: 8 }}
                        exit={{ opacity: 0, width: 0, marginLeft: 0 }}
                        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                        className="flex items-center gap-1.5 overflow-hidden shrink-0"
                      >
                        <button
                          type="button"
                          onClick={() => setChatFilter('all')}
                          className={`px-2.5 h-9 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                            chatFilter === 'all'
                              ? 'bg-[#E7FCE3] text-[#008069] dark:bg-[#0A332C] dark:text-[#00A884]'
                              : 'bg-[#F0F2F5] text-[#54656F] hover:bg-[#E9EDEF] dark:bg-[#202C33] dark:text-[#8696A0] dark:hover:bg-[#2A3942]'
                          }`}
                        >
                          All
                        </button>
                        <button
                          type="button"
                          onClick={() => setChatFilter('unread')}
                          className={`px-2.5 h-9 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                            chatFilter === 'unread'
                              ? 'bg-[#E7FCE3] text-[#008069] dark:bg-[#0A332C] dark:text-[#00A884]'
                              : 'bg-[#F0F2F5] text-[#54656F] hover:bg-[#E9EDEF] dark:bg-[#202C33] dark:text-[#8696A0] dark:hover:bg-[#2A3942]'
                          }`}
                        >
                          Unread{totalUnreadChats > 0 ? ` (${totalUnreadChats})` : ''}
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>

              {/* Chat List Rows */}
              <div className="flex-1 overflow-y-auto wa-scroll divide-y divide-[#F0F2F5] dark:divide-[#222E35]">
                {chatList.length === 0 ? (
                  <div className="px-6 py-14 text-center flex flex-col items-center">
                    <div className="w-14 h-14 rounded-full bg-[#F0F2F5] dark:bg-[#202C33] flex items-center justify-center text-[#00A884] mb-4">
                      <MessageSquare className="w-6 h-6" />
                    </div>
                    <h2 className="text-base font-semibold text-[#111B21] dark:text-[#E9EDEF]">
                      {chatSearch || chatFilter === 'unread'
                        ? 'No matching conversations'
                        : 'No conversations yet'}
                    </h2>
                    <p className="mt-1.5 text-sm text-[#667781] dark:text-[#8696A0] max-w-[260px]">
                      {chatSearch || chatFilter === 'unread'
                        ? 'Try adjusting your search or filter to find chats.'
                        : 'Search for registered users or add a new contact to start your first chat.'}
                    </p>
                    {!chatSearch && chatFilter === 'all' && (
                      <button
                        type="button"
                        onClick={() => {
                          setSidebarView('new-chat');
                          setDirectorySearch('');
                        }}
                        className="mt-5 px-4 py-2.5 rounded-lg bg-[#00A884] hover:bg-[#008F72] text-white text-sm font-medium transition-colors flex items-center gap-2 whitespace-nowrap cursor-pointer min-h-[44px]"
                      >
                        <UserPlus className="w-4 h-4" />
                        <span>Start a conversation</span>
                      </button>
                    )}
                  </div>
                ) : (
                  chatList.map((chat) => {
                    const peer: UserAccount = store.users[chat.peerId] ?? {
                      id: chat.peerId,
                      displayName: chat.peerId,
                      about: 'Available',
                      avatarColor: pickAvatarColor(chat.peerId),
                      isRegistered: true,
                      createdAt: chat.lastMessage?.timestamp ?? Date.now(),
                      lastSeen: chat.lastMessage?.timestamp ?? Date.now(),
                    };
                    const displayName = getPeerDisplayName(chat.peerId);
                    const isSelected = activePeerId === chat.peerId;
                    const lastMsg = chat.lastMessage;
                    const isOutgoing = lastMsg?.senderId === currentUser.id;
                    const peerOnline = isUserOnline(store, chat.peerId);

                    return (
                      <button
                        key={chat.peerId}
                        type="button"
                        onClick={() => handleOpenChat(chat.peerId)}
                        className={`w-full px-3.5 py-3 flex items-center gap-3 text-left transition-colors cursor-pointer min-h-[72px] ${
                          isSelected
                            ? 'bg-[#F0F2F5] dark:bg-[#2A3942]'
                            : 'hover:bg-[#F5F6F6] dark:hover:bg-[#202C33]'
                        }`}
                      >
                        <div className="relative shrink-0">
                          <UserAvatar name={displayName} color={peer.avatarColor} />
                          {peerOnline && (
                            <span
                              className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-[#25D366] ring-2 ring-white dark:ring-[#111B21]"
                              title="Online"
                            />
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <span
                              className={`text-[15px] truncate ${
                                chat.unreadCount > 0
                                  ? 'font-semibold text-[#111B21] dark:text-[#E9EDEF]'
                                  : 'font-medium text-[#111B21] dark:text-[#E9EDEF]'
                              }`}
                            >
                              {displayName}
                            </span>
                            {lastMsg && (
                              <span
                                className={`text-xs font-mono-tabular shrink-0 ${
                                  chat.unreadCount > 0
                                    ? 'text-[#00A884] font-semibold'
                                    : 'text-[#667781] dark:text-[#8696A0]'
                                }`}
                              >
                                {formatChatListTime(lastMsg.timestamp)}
                              </span>
                            )}
                          </div>

                          <div className="mt-0.5 flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1 min-w-0 flex-1">
                              {isOutgoing && lastMsg && (
                                <StatusTicks status={lastMsg.status} />
                              )}
                              <span
                                className={`text-[13px] truncate flex items-center gap-1 ${
                                  chat.unreadCount > 0
                                    ? 'font-medium text-[#111B21] dark:text-[#E9EDEF]'
                                    : 'text-[#667781] dark:text-[#8696A0]'
                                }`}
                              >
                                {lastMsg?.imageBase64 && (
                                  <Camera className="w-3.5 h-3.5 shrink-0 inline-block" />
                                )}
                                <span className="truncate">
                                  {lastMsg
                                    ? lastMsg.text || (lastMsg.imageBase64 ? 'Photo' : '')
                                    : 'No messages yet'}
                                </span>
                              </span>
                            </div>

                            {chat.unreadCount > 0 && (
                              <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-[#00A884] text-white text-[11px] font-semibold font-mono-tabular flex items-center justify-center shrink-0">
                                {chat.unreadCount}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </>
          ) : sidebarView === 'new-chat' ? (
            /* ================================================================ */
            /* NEW CHAT & CONTACTS DRAWER VIEW                                  */
            /* ================================================================ */
            <>
              <header className="h-[60px] px-3 bg-[#008069] dark:bg-[#202C33] text-white flex items-center gap-3 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setSidebarView('chats');
                    setShowAddContactForm(false);
                    setContactError('');
                  }}
                  aria-label="Back to chats"
                  className="min-w-[44px] min-h-[44px] rounded-full flex items-center justify-center hover:bg-white/10 transition-colors cursor-pointer"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <h2 className="text-base font-semibold tracking-tight">New chat</h2>
              </header>

              {/* Directory Search + Add Contact Trigger */}
              <div className="p-3 bg-white dark:bg-[#111B21] border-b border-[#E9EDEF] dark:border-[#222E35] space-y-2.5 shrink-0">
                <motion.div
                  animate={{
                    height: isDirectorySearchExpanded ? 44 : 38,
                  }}
                  transition={{
                    type: 'spring',
                    stiffness: 440,
                    damping: 32,
                    mass: 0.8,
                  }}
                  className={`relative flex items-center rounded-lg transition-colors ${
                    isDirectorySearchExpanded
                      ? 'bg-white dark:bg-[#2A3942] ring-1 ring-[#00A884] shadow-sm'
                      : 'bg-[#F0F2F5] dark:bg-[#202C33] ring-1 ring-transparent'
                  }`}
                >
                  <Search
                    className={`w-4 h-4 absolute left-3.5 pointer-events-none transition-colors ${
                      isDirectorySearchExpanded
                        ? 'text-[#00A884]'
                        : 'text-[#54656F] dark:text-[#8696A0]'
                    }`}
                  />
                  <input
                    type="text"
                    autoFocus
                    value={directorySearch}
                    onFocus={() => setIsDirectorySearchFocused(true)}
                    onBlur={() => setIsDirectorySearchFocused(false)}
                    onChange={(e) => setDirectorySearch(e.target.value)}
                    placeholder="Search registered users or contacts"
                    className="w-full h-full pl-10 pr-8 bg-transparent text-sm text-[#111B21] dark:text-[#E9EDEF] placeholder-[#667781] dark:placeholder-[#8696A0] focus:outline-none"
                  />
                  <AnimatePresence initial={false}>
                    {directorySearch && (
                      <motion.button
                        key="clear-directory-search"
                        type="button"
                        initial={{ opacity: 0, scale: 0.7 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.7 }}
                        transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => setDirectorySearch('')}
                        aria-label="Clear search"
                        className="absolute right-2 p-1 rounded-full text-[#667781] hover:text-[#111B21] dark:hover:text-[#E9EDEF] cursor-pointer"
                      >
                        <X className="w-4 h-4" />
                      </motion.button>
                    )}
                  </AnimatePresence>
                </motion.div>

                {!showAddContactForm ? (
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddContactForm(true);
                      setNewContactName(directorySearch);
                      setContactError('');
                    }}
                    className="w-full px-3 py-2.5 rounded-lg flex items-center gap-3 hover:bg-[#F5F6F6] dark:hover:bg-[#202C33] transition-colors text-left cursor-pointer min-h-[48px]"
                  >
                    <div className="w-10 h-10 rounded-full bg-[#00A884] text-white flex items-center justify-center shrink-0">
                      <UserPlus className="w-5 h-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-[#111B21] dark:text-[#E9EDEF]">
                        Add new contact
                      </div>
                      <div className="text-xs text-[#667781] dark:text-[#8696A0]">
                        Save someone by name and send offline messages
                      </div>
                    </div>
                  </button>
                ) : (
                  <form
                    onSubmit={(e) => handleAddContact(e, true)}
                    className="p-3.5 rounded-lg bg-[#F0F2F5] dark:bg-[#202C33] space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-[#111B21] dark:text-[#E9EDEF]">
                        New contact
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setShowAddContactForm(false);
                          setContactError('');
                        }}
                        aria-label="Cancel add contact"
                        className="p-1 text-[#667781] hover:text-[#111B21] dark:hover:text-[#E9EDEF] cursor-pointer"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    <div>
                      <input
                        type="text"
                        value={newContactName}
                        onChange={(e) => {
                          setNewContactName(e.target.value);
                          if (contactError) setContactError('');
                        }}
                        placeholder="Account name (e.g., Aisha)"
                        maxLength={40}
                        className="w-full h-10 px-3 rounded-md bg-white dark:bg-[#2A3942] text-sm text-[#111B21] dark:text-[#E9EDEF] placeholder-[#667781] dark:placeholder-[#8696A0] border border-[#D1D7DB] dark:border-[#374248] focus:outline-none focus:border-[#00A884]"
                      />
                    </div>

                    <div>
                      <input
                        type="text"
                        value={newContactNickname}
                        onChange={(e) => setNewContactNickname(e.target.value)}
                        placeholder="Display nickname (optional)"
                        maxLength={40}
                        className="w-full h-10 px-3 rounded-md bg-white dark:bg-[#2A3942] text-sm text-[#111B21] dark:text-[#E9EDEF] placeholder-[#667781] dark:placeholder-[#8696A0] border border-[#D1D7DB] dark:border-[#374248] focus:outline-none focus:border-[#00A884]"
                      />
                    </div>

                    {contactError && (
                      <p className="text-xs font-medium text-[#DC2626] dark:text-[#F87171]">
                        {contactError}
                      </p>
                    )}

                    <div className="flex items-center gap-2">
                      <button
                        type="submit"
                        className="flex-1 h-10 px-3 rounded-md bg-[#00A884] hover:bg-[#008F72] text-white text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap"
                      >
                        Save &amp; Message
                      </button>
                      <button
                        type="button"
                        onClick={(e) => handleAddContact(e, false)}
                        className="h-10 px-3 rounded-md border border-[#D1D7DB] dark:border-[#374248] text-[#111B21] dark:text-[#E9EDEF] hover:bg-black/5 dark:hover:bg-white/5 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap"
                      >
                        Save Only
                      </button>
                    </div>
                  </form>
                )}
              </div>

              {/* Contacts & Registered Users List */}
              <div className="flex-1 overflow-y-auto wa-scroll">
                {myContactsList.length > 0 && (
                  <div>
                    <div className="px-4 py-2.5 text-xs font-semibold text-[#008069] dark:text-[#00A884] bg-[#F8F9FA] dark:bg-[#182229] border-b border-[#E9EDEF] dark:border-[#222E35]">
                      My contacts
                    </div>
                    <div className="divide-y divide-[#F0F2F5] dark:divide-[#222E35]">
                      {myContactsList.map(({ user, label }) => {
                        const online = isUserOnline(store, user.id);
                        return (
                          <button
                            key={user.id}
                            type="button"
                            onClick={() => handleOpenChat(user.id)}
                            className="w-full px-4 py-3 flex items-center gap-3 hover:bg-[#F5F6F6] dark:hover:bg-[#202C33] text-left transition-colors cursor-pointer min-h-[64px]"
                          >
                            <div className="relative shrink-0">
                              <UserAvatar name={label} color={user.avatarColor} />
                              {online && (
                                <span className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-[#25D366] ring-2 ring-white dark:ring-[#111B21]" />
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="text-[15px] font-medium text-[#111B21] dark:text-[#E9EDEF] truncate">
                                {label}
                              </div>
                              <div className="text-xs text-[#667781] dark:text-[#8696A0] truncate">
                                {online
                                  ? 'Online'
                                  : user.isRegistered
                                    ? user.about
                                    : 'Pending login — offline messages will be delivered'}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {otherRegisteredUsers.length > 0 && (
                  <div>
                    <div className="px-4 py-2.5 text-xs font-semibold text-[#008069] dark:text-[#00A884] bg-[#F8F9FA] dark:bg-[#182229] border-y border-[#E9EDEF] dark:border-[#222E35]">
                      Registered users
                    </div>
                    <div className="divide-y divide-[#F0F2F5] dark:divide-[#222E35]">
                      {otherRegisteredUsers.map((user) => {
                        const online = isUserOnline(store, user.id);
                        return (
                          <button
                            key={user.id}
                            type="button"
                            onClick={() => handleOpenChat(user.id)}
                            className="w-full px-4 py-3 flex items-center gap-3 hover:bg-[#F5F6F6] dark:hover:bg-[#202C33] text-left transition-colors cursor-pointer min-h-[64px]"
                          >
                            <div className="relative shrink-0">
                              <UserAvatar name={user.displayName} color={user.avatarColor} />
                              {online && (
                                <span className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-[#25D366] ring-2 ring-white dark:ring-[#111B21]" />
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="text-[15px] font-medium text-[#111B21] dark:text-[#E9EDEF] truncate">
                                {user.displayName}
                              </div>
                              <div className="text-xs text-[#667781] dark:text-[#8696A0] truncate">
                                {online ? 'Online' : user.about}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {myContactsList.length === 0 && otherRegisteredUsers.length === 0 && (
                  <div className="px-6 py-12 text-center flex flex-col items-center">
                    <div className="w-12 h-12 rounded-full bg-[#F0F2F5] dark:bg-[#202C33] flex items-center justify-center text-[#54656F] dark:text-[#8696A0] mb-3">
                      <Users className="w-6 h-6" />
                    </div>
                    <p className="text-sm font-medium text-[#111B21] dark:text-[#E9EDEF]">
                      {directorySearch
                        ? `No users found for "${directorySearch}"`
                        : 'No other users or contacts yet'}
                    </p>
                    <p className="mt-1 text-xs text-[#667781] dark:text-[#8696A0] max-w-[250px]">
                      Add a contact by name above to send them a message right now — even if they have not logged in yet.
                    </p>
                  </div>
                )}
              </div>
            </>
          ) : sidebarView === 'settings' ? (
            /* ================================================================ */
            /* APPLICATION SETTINGS VIEW                                        */
            /* ================================================================ */
            <>
              <header className="h-[60px] px-3 bg-[#008069] dark:bg-[#202C33] text-white flex items-center gap-3 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setSidebarView('chats');
                    setEditingAbout(false);
                  }}
                  aria-label="Back to chats"
                  className="min-w-[44px] min-h-[44px] rounded-full flex items-center justify-center hover:bg-white/10 transition-colors cursor-pointer"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <h2 className="text-base font-semibold tracking-tight">Settings</h2>
              </header>

              <div className="flex-1 overflow-y-auto wa-scroll">
                {/* User Profile Summary & Status Editor */}
                <div className="px-5 py-6 border-b border-[#E9EDEF] dark:border-[#222E35] flex items-start gap-4">
                  <UserAvatar
                    name={currentUser.displayName}
                    color={currentUser.avatarColor}
                    size="lg"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-base font-semibold text-[#111B21] dark:text-[#E9EDEF] truncate">
                      {currentUser.displayName}
                    </div>
                    {!editingAbout ? (
                      <div className="mt-1 flex items-center justify-between gap-2">
                        <span className="text-sm text-[#667781] dark:text-[#8696A0] truncate">
                          {currentUser.about}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setAboutDraft(currentUser.about);
                            setEditingAbout(true);
                          }}
                          className="text-xs font-medium text-[#008069] dark:text-[#00A884] hover:underline whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Edit
                        </button>
                      </div>
                    ) : (
                      <form onSubmit={handleSaveAbout} className="mt-2 space-y-2">
                        <input
                          type="text"
                          autoFocus
                          value={aboutDraft}
                          onChange={(e) => setAboutDraft(e.target.value)}
                          maxLength={70}
                          placeholder="Status line"
                          className="w-full h-9 px-3 rounded-md bg-[#F0F2F5] dark:bg-[#202C33] text-sm text-[#111B21] dark:text-[#E9EDEF] border border-[#00A884] focus:outline-none"
                        />
                        <div className="flex items-center gap-2">
                          <button
                            type="submit"
                            className="px-3 py-1.5 rounded-md bg-[#00A884] hover:bg-[#008F72] text-white text-xs font-semibold cursor-pointer whitespace-nowrap"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingAbout(false)}
                            className="px-3 py-1.5 rounded-md text-xs font-medium text-[#54656F] dark:text-[#8696A0] hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer whitespace-nowrap"
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    )}
                  </div>
                </div>

                {/* Settings Menu List */}
                <nav aria-label="Application settings" className="divide-y divide-[#F0F2F5] dark:divide-[#222E35]">
                  <button
                    type="button"
                    onClick={() => setSidebarView('wallpaper')}
                    className="w-full px-5 py-4 flex items-center gap-4 hover:bg-[#F5F6F6] dark:hover:bg-[#202C33] text-left transition-colors cursor-pointer min-h-[64px]"
                  >
                    <div className="w-10 h-10 rounded-full bg-[#F0F2F5] dark:bg-[#202C33] flex items-center justify-center text-[#54656F] dark:text-[#AEBAC1] shrink-0">
                      <ImageIcon className="w-5 h-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[15px] font-medium text-[#111B21] dark:text-[#E9EDEF]">
                        Chat wallpaper
                      </div>
                      <div className="text-xs text-[#667781] dark:text-[#8696A0] truncate">
                        {activeWallpaper.name}
                        {activeWallpaperDoodle ? ' · Doodle pattern on' : ' · Solid background'}
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-[#8696A0] shrink-0" />
                  </button>

                  <button
                    type="button"
                    onClick={() => setDarkMode((d) => !d)}
                    className="w-full px-5 py-4 flex items-center gap-4 hover:bg-[#F5F6F6] dark:hover:bg-[#202C33] text-left transition-colors cursor-pointer min-h-[64px]"
                  >
                    <div className="w-10 h-10 rounded-full bg-[#F0F2F5] dark:bg-[#202C33] flex items-center justify-center text-[#54656F] dark:text-[#AEBAC1] shrink-0">
                      {darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[15px] font-medium text-[#111B21] dark:text-[#E9EDEF]">
                        Theme
                      </div>
                      <div className="text-xs text-[#667781] dark:text-[#8696A0]">
                        {darkMode ? 'Dark mode' : 'Light mode'}
                      </div>
                    </div>
                    <span className="text-xs font-medium text-[#008069] dark:text-[#00A884] whitespace-nowrap shrink-0">
                      Switch
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={handleLogout}
                    className="w-full px-5 py-4 flex items-center gap-4 hover:bg-[#F5F6F6] dark:hover:bg-[#202C33] text-left transition-colors cursor-pointer min-h-[64px]"
                  >
                    <div className="w-10 h-10 rounded-full bg-[#DC2626]/10 flex items-center justify-center text-[#DC2626] dark:text-[#F87171] shrink-0">
                      <LogOut className="w-5 h-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[15px] font-medium text-[#DC2626] dark:text-[#F87171]">
                        Log out
                      </div>
                      <div className="text-xs text-[#667781] dark:text-[#8696A0]">
                        Sign out of {currentUser.displayName}
                      </div>
                    </div>
                  </button>
                </nav>
              </div>
            </>
          ) : (
            /* ================================================================ */
            /* CHAT WALLPAPER THEME SELECTOR MENU                               */
            /* ================================================================ */
            <>
              <header className="h-[60px] px-3 bg-[#008069] dark:bg-[#202C33] text-white flex items-center gap-3 shrink-0">
                <button
                  type="button"
                  onClick={() => setSidebarView('settings')}
                  aria-label="Back to settings"
                  className="min-w-[44px] min-h-[44px] rounded-full flex items-center justify-center hover:bg-white/10 transition-colors cursor-pointer"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <h2 className="text-base font-semibold tracking-tight">Chat wallpaper</h2>
              </header>

              <div className="flex-1 overflow-y-auto wa-scroll p-4 space-y-5">
                {/* Live Wallpaper Mini Preview */}
                <div className="space-y-2">
                  <div className="text-xs font-semibold text-[#54656F] dark:text-[#8696A0]">
                    Preview
                  </div>
                  <div
                    className={`rounded-xl border border-[#E9EDEF] dark:border-[#222E35] p-3.5 space-y-2 ${activeWallpaper.cssClass} ${
                      activeWallpaperDoodle ? 'wa-doodle-overlay' : ''
                    }`}
                  >
                    <div className="flex justify-start">
                      <div className="px-3 py-1.5 rounded-lg rounded-tl-none bg-white dark:bg-[#202C33] text-[#111B21] dark:text-[#E9EDEF] text-xs shadow-xs max-w-[80%]">
                        <span>Looks clean! Which wallpaper is this?</span>
                        <span className="ml-2 text-[10px] font-mono-tabular text-[#667781] dark:text-[#8696A0]">
                          10:42 AM
                        </span>
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <div className="px-3 py-1.5 rounded-lg rounded-tr-none bg-[#D9FDD3] dark:bg-[#005C4B] text-[#111B21] dark:text-[#E9EDEF] text-xs shadow-xs max-w-[80%] flex items-end gap-1.5">
                        <span>{activeWallpaper.name}</span>
                        <span className="inline-flex items-center gap-0.5 text-[10px] font-mono-tabular text-[#667781] dark:text-[#8696A0]">
                          10:43 AM
                          <CheckCheck className="w-3.5 h-3.5 text-[#53BDEB]" />
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Doodle Pattern Toggle */}
                <label className="flex items-center justify-between gap-3 px-3.5 py-3 rounded-lg bg-[#F0F2F5] dark:bg-[#202C33] cursor-pointer min-h-[48px]">
                  <div>
                    <div className="text-sm font-medium text-[#111B21] dark:text-[#E9EDEF]">
                      WhatsApp doodle pattern
                    </div>
                    <div className="text-xs text-[#667781] dark:text-[#8696A0]">
                      Overlay subtle geometric icons on the wallpaper
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={activeWallpaperDoodle}
                    onChange={handleToggleWallpaperDoodle}
                    className="w-4 h-4 accent-[#00A884] cursor-pointer shrink-0"
                  />
                </label>

                {/* Pre-defined Wallpaper Theme Grid */}
                <div className="space-y-2.5">
                  <div className="text-xs font-semibold text-[#54656F] dark:text-[#8696A0]">
                    Select a theme
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    {WALLPAPER_THEMES.map((theme) => {
                      const isSelected = activeWallpaperId === theme.id;
                      return (
                        <button
                          key={theme.id}
                          type="button"
                          onClick={() => handleSelectWallpaper(theme)}
                          className={`group rounded-xl border text-left overflow-hidden transition-all cursor-pointer ${
                            isSelected
                              ? 'border-[#00A884] ring-2 ring-[#00A884]/25'
                              : 'border-[#E9EDEF] dark:border-[#2A3942] hover:border-[#8696A0]'
                          }`}
                        >
                          <div
                            className={`h-16 w-full relative ${theme.cssClass} ${
                              theme.defaultDoodle ? 'wa-doodle-overlay' : ''
                            } border-b border-black/5 dark:border-white/5`}
                          >
                            {isSelected && (
                              <span className="absolute top-2 right-2 w-6 h-6 rounded-full bg-[#00A884] text-white flex items-center justify-center shadow-xs">
                                <Check className="w-3.5 h-3.5" />
                              </span>
                            )}
                          </div>
                          <div className="p-2.5 bg-white dark:bg-[#111B21]">
                            <div className="text-xs font-semibold text-[#111B21] dark:text-[#E9EDEF] truncate">
                              {theme.name}
                            </div>
                            <div className="text-[11px] text-[#667781] dark:text-[#8696A0] truncate">
                              {theme.description}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </>
          )}
        </aside>

        {/* ================================================================== */}
        {/* RIGHT PANEL: Active Chat Window OR Empty Welcome Workspace         */}
        {/* ================================================================== */}
        <main
          className={`${
            activePeerId ? 'flex' : 'hidden md:flex'
          } flex-1 flex-col min-w-0 min-h-0 bg-[#EFEAE2] dark:bg-[#0B141A]`}
        >
          {activePeer && activePeerId ? (
            <>
              {/* Active Chat Header */}
              <header className="h-[60px] px-3 sm:px-4 bg-[#F0F2F5] dark:bg-[#202C33] border-b border-[#E9EDEF] dark:border-[#222E35] flex items-center justify-between gap-3 shrink-0 z-10">
                <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                  <button
                    type="button"
                    onClick={() => setActivePeerId(null)}
                    aria-label="Back to chat list"
                    className="md:hidden min-w-[44px] min-h-[44px] -ml-1 rounded-full flex items-center justify-center text-[#54656F] dark:text-[#AEBAC1] hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
                  >
                    <ArrowLeft className="w-5 h-5" />
                  </button>

                  <UserAvatar
                    name={getPeerDisplayName(activePeerId)}
                    color={activePeer.avatarColor}
                    size="sm"
                  />

                  <div className="min-w-0">
                    <div className="text-[15px] font-semibold text-[#111B21] dark:text-[#E9EDEF] truncate">
                      {getPeerDisplayName(activePeerId)}
                    </div>
                    <div
                      className={`text-xs truncate ${
                        activePeerTyping
                          ? 'text-[#00A884] font-medium'
                          : 'text-[#667781] dark:text-[#8696A0] font-mono-tabular'
                      }`}
                    >
                      {activePeerTyping
                        ? 'typing...'
                        : formatLastSeen(activePeer, activePeerOnline)}
                    </div>
                  </div>
                </div>

                {/* Chat Header Actions */}
                <div className="flex items-center gap-1 relative shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      setInChatSearchOpen((v) => !v);
                      setInChatSearchQuery('');
                    }}
                    title="Search in conversation"
                    aria-label="Search in conversation"
                    className="min-w-[44px] min-h-[44px] rounded-full flex items-center justify-center text-[#54656F] dark:text-[#AEBAC1] hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
                  >
                    <Search className="w-5 h-5" />
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowChatMenu((v) => !v)}
                    title="Chat options"
                    aria-label="Chat options"
                    className="min-w-[44px] min-h-[44px] rounded-full flex items-center justify-center text-[#54656F] dark:text-[#AEBAC1] hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
                  >
                    <MoreVertical className="w-5 h-5" />
                  </button>

                  {showChatMenu && (
                    <div className="absolute right-0 top-12 w-48 bg-white dark:bg-[#233138] rounded-lg shadow-lg border border-[#E9EDEF] dark:border-[#2A3942] py-1.5 z-30">
                      <button
                        type="button"
                        onClick={handleClearConversation}
                        className="w-full px-4 py-2.5 text-left text-sm text-[#DC2626] dark:text-[#F87171] hover:bg-[#F5F6F6] dark:hover:bg-[#182229] flex items-center gap-2.5 cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                        <span>Clear messages</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowChatMenu(false);
                          setActivePeerId(null);
                        }}
                        className="w-full px-4 py-2.5 text-left text-sm text-[#111B21] dark:text-[#E9EDEF] hover:bg-[#F5F6F6] dark:hover:bg-[#182229] flex items-center gap-2.5 cursor-pointer"
                      >
                        <X className="w-4 h-4" />
                        <span>Close chat</span>
                      </button>
                    </div>
                  )}
                </div>
              </header>

              {/* Animated In-Chat Search Bar */}
              <AnimatePresence initial={false}>
                {inChatSearchOpen && (
                  <motion.div
                    key="in-chat-search-bar"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                    className="overflow-hidden shrink-0 bg-[#F0F2F5] dark:bg-[#202C33] border-b border-[#E9EDEF] dark:border-[#222E35]"
                  >
                    <div className="px-4 py-2 flex items-center gap-2">
                      <Search className="w-4 h-4 text-[#00A884] shrink-0" />
                      <input
                        type="text"
                        autoFocus
                        value={inChatSearchQuery}
                        onChange={(e) => setInChatSearchQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            setInChatSearchOpen(false);
                            setInChatSearchQuery('');
                          }
                        }}
                        placeholder="Search messages in this chat..."
                        className="flex-1 bg-transparent text-sm text-[#111B21] dark:text-[#E9EDEF] placeholder-[#667781] focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setInChatSearchOpen(false);
                          setInChatSearchQuery('');
                        }}
                        aria-label="Close in-chat search"
                        className="p-1.5 text-[#667781] hover:text-[#111B21] dark:hover:text-[#E9EDEF] cursor-pointer"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Message Feed */}
              <div
                className={`flex-1 overflow-y-auto wa-scroll ${activeWallpaper.cssClass} ${
                  activeWallpaperDoodle ? 'wa-doodle-overlay' : ''
                } px-3 sm:px-6 lg:px-12 py-4 space-y-1.5 min-h-0 transition-colors`}
                onClick={() => {
                  if (showChatMenu) setShowChatMenu(false);
                  if (showEmojiPicker) setShowEmojiPicker(false);
                  if (expandedReactionMsgId) setExpandedReactionMsgId(null);
                }}
              >
                {filteredConversationMessages.length === 0 ? (
                  <div className="h-full flex items-center justify-center">
                    <div className="max-w-sm text-center px-5 py-4 rounded-xl bg-white/90 dark:bg-[#182229]/90 shadow-xs border border-black/5 dark:border-white/5">
                      <p className="text-sm font-medium text-[#111B21] dark:text-[#E9EDEF]">
                        {inChatSearchQuery
                          ? 'No messages match your search'
                          : `Start chatting with ${getPeerDisplayName(activePeerId)}`}
                      </p>
                      {!inChatSearchQuery && (
                        <p className="mt-1 text-xs text-[#667781] dark:text-[#8696A0]">
                          {activePeerOnline
                            ? `${getPeerDisplayName(activePeerId)} is online right now.`
                            : `${getPeerDisplayName(activePeerId)} is currently offline. Your message will be saved in LocalStorage and delivered as unread when they sign in.`}
                        </p>
                      )}
                    </div>
                  </div>
                ) : (
                  filteredConversationMessages.map((msg, idx) => {
                    const isMine = msg.senderId === currentUser.id;
                    const prevMsg = idx > 0 ? filteredConversationMessages[idx - 1] : null;
                    const showDateDivider =
                      !prevMsg ||
                      formatDateSeparator(prevMsg.timestamp) !==
                        formatDateSeparator(msg.timestamp);
                    const isFirstInGroup = !prevMsg || prevMsg.senderId !== msg.senderId || showDateDivider;

                    const showUnreadBanner =
                      unreadBannerState !== null &&
                      unreadBannerState.firstMessageId === msg.id;

                    const myReaction = msg.reactions?.[currentUser.id];
                    const reactionGroups: Array<{ emoji: string; users: string[] }> = [];
                    if (msg.reactions) {
                      const grouped = new Map<string, string[]>();
                      for (const [uid, emoji] of Object.entries(msg.reactions)) {
                        const list = grouped.get(emoji) ?? [];
                        list.push(uid);
                        grouped.set(emoji, list);
                      }
                      for (const [emoji, users] of grouped.entries()) {
                        reactionGroups.push({ emoji, users });
                      }
                    }

                    const isExpandedPicker = expandedReactionMsgId === msg.id;
                    const placePickerBelow = idx === 0 && reactionGroups.length === 0;

                    return (
                      <React.Fragment key={msg.id}>
                        {showDateDivider && (
                          <div className="flex justify-center my-3">
                            <span className="px-3 py-1 rounded-lg bg-white/90 dark:bg-[#182229]/95 text-[#54656F] dark:text-[#8696A0] text-xs font-medium shadow-[0_1px_0.5px_rgba(11,20,26,0.1)]">
                              {formatDateSeparator(msg.timestamp)}
                            </span>
                          </div>
                        )}

                        {showUnreadBanner && unreadBannerState && (
                          <div className="flex justify-center my-2.5">
                            <span className="px-4 py-1 rounded-lg bg-white/95 dark:bg-[#182229] text-[#008069] dark:text-[#00A884] text-xs font-semibold shadow-xs">
                              {unreadBannerState.count} unread message
                              {unreadBannerState.count > 1 ? 's' : ''}
                            </span>
                          </div>
                        )}

                        <div
                          className={`flex ${isMine ? 'justify-end' : 'justify-start'} ${
                            isFirstInGroup ? 'mt-2.5' : 'mt-0.5'
                          }`}
                        >
                          <div
                            onMouseLeave={() => {
                              if (expandedReactionMsgId === msg.id) {
                                setExpandedReactionMsgId(null);
                              }
                            }}
                            className={`group/msg relative flex flex-col max-w-[85%] sm:max-w-[72%] lg:max-w-[62%] ${
                              isMine ? 'items-end' : 'items-start'
                            }`}
                          >
                            {/* Hover / Focus Emoji Reaction Picker */}
                            <div
                              className={`absolute z-20 transition-all duration-150 ${
                                placePickerBelow ? 'top-full pt-1.5' : 'bottom-full pb-1.5'
                              } ${isMine ? 'right-0' : 'left-0'} ${
                                isExpandedPicker
                                  ? 'opacity-100 pointer-events-auto scale-100'
                                  : 'opacity-0 pointer-events-none scale-95 group-hover/msg:opacity-100 group-hover/msg:pointer-events-auto group-hover/msg:scale-100 focus-within:opacity-100 focus-within:pointer-events-auto focus-within:scale-100'
                              }`}
                            >
                              <div className="bg-white dark:bg-[#233138] border border-[#E9EDEF] dark:border-[#2A3942] rounded-2xl shadow-lg px-1.5 py-1 flex items-center gap-0.5">
                                {REACTION_EMOJIS.map((emoji) => {
                                  const isActive = myReaction === emoji;
                                  return (
                                    <button
                                      key={emoji}
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleToggleReaction(msg.id, emoji);
                                      }}
                                      aria-label={`React with ${emoji}`}
                                      className={`w-8 h-8 rounded-full flex items-center justify-center text-lg transition-transform hover:scale-125 cursor-pointer ${
                                        isActive
                                          ? 'bg-[#E7FCE3] dark:bg-[#0A332C] ring-1 ring-[#00A884]/50'
                                          : 'hover:bg-[#F0F2F5] dark:hover:bg-[#2A3942]'
                                      }`}
                                    >
                                      {emoji}
                                    </button>
                                  );
                                })}
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setExpandedReactionMsgId((prev) =>
                                      prev === msg.id ? null : msg.id
                                    );
                                  }}
                                  aria-label="More reaction emojis"
                                  title="More emojis"
                                  className="w-7 h-7 rounded-full flex items-center justify-center text-[#54656F] dark:text-[#AEBAC1] hover:bg-[#F0F2F5] dark:hover:bg-[#2A3942] transition-colors cursor-pointer"
                                >
                                  <Plus className="w-4 h-4" />
                                </button>
                              </div>

                              {isExpandedPicker && (
                                <div
                                  onClick={(e) => e.stopPropagation()}
                                  className={`mt-1.5 bg-white dark:bg-[#233138] border border-[#E9EDEF] dark:border-[#2A3942] rounded-xl shadow-xl p-2 grid grid-cols-6 gap-1 w-[224px] ${
                                    isMine ? 'ml-auto' : 'mr-auto'
                                  }`}
                                >
                                  {QUICK_EMOJIS.map((emoji) => {
                                    const isActive = myReaction === emoji;
                                    return (
                                      <button
                                        key={emoji}
                                        type="button"
                                        onClick={() => handleToggleReaction(msg.id, emoji)}
                                        aria-label={`React with ${emoji}`}
                                        className={`w-8 h-8 rounded-md flex items-center justify-center text-base transition-colors cursor-pointer ${
                                          isActive
                                            ? 'bg-[#E7FCE3] dark:bg-[#0A332C] ring-1 ring-[#00A884]/50'
                                            : 'hover:bg-[#F0F2F5] dark:hover:bg-[#2A3942]'
                                        }`}
                                      >
                                        {emoji}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>

                            {/* Message Bubble */}
                            <div
                              onClick={() => {
                                // Allow touch/click fallback on mobile to open reaction bar if desired
                                if (window.matchMedia('(hover: none)').matches) {
                                  setExpandedReactionMsgId((prev) =>
                                    prev === msg.id ? null : msg.id
                                  );
                                }
                              }}
                              className={`relative w-full rounded-lg shadow-[0_1px_0.5px_rgba(11,20,26,0.13)] text-[14.5px] leading-relaxed break-words ${
                                msg.imageBase64 ? 'p-1.5' : 'px-3 py-1.5'
                              } ${
                                isMine
                                  ? 'bg-[#D9FDD3] dark:bg-[#005C4B] text-[#111B21] dark:text-[#E9EDEF]'
                                  : 'bg-white dark:bg-[#202C33] text-[#111B21] dark:text-[#E9EDEF]'
                              } ${
                                isFirstInGroup
                                  ? isMine
                                    ? 'rounded-tr-none'
                                    : 'rounded-tl-none'
                                  : ''
                              }`}
                            >
                              {msg.imageBase64 && (
                                <div className="relative rounded-md overflow-hidden bg-black/5 dark:bg-black/25">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setLightboxImage({
                                        src: msg.imageBase64!,
                                        caption: msg.text,
                                        senderName: isMine
                                          ? 'You'
                                          : getPeerDisplayName(msg.senderId),
                                        timestamp: msg.timestamp,
                                      });
                                    }}
                                    aria-label="View full photo"
                                    className="block w-full cursor-zoom-in focus:outline-none"
                                  >
                                    <img
                                      src={msg.imageBase64}
                                      alt={msg.text || 'Shared camera photo'}
                                      className="w-full max-w-[320px] max-h-[340px] object-cover block"
                                    />
                                  </button>
                                  {!msg.text && (
                                    <span className="absolute bottom-1.5 right-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/55 text-white select-none pointer-events-none">
                                      <span className="text-[11px] font-mono-tabular">
                                        {formatMessageTime(msg.timestamp)}
                                      </span>
                                      {isMine && (
                                        <StatusTicks
                                          status={msg.status}
                                          className={
                                            msg.status === 'read'
                                              ? '!text-[#53BDEB]'
                                              : '!text-white/90'
                                          }
                                        />
                                      )}
                                    </span>
                                  )}
                                </div>
                              )}

                              {(msg.text || !msg.imageBase64) && (
                                <div className={msg.imageBase64 ? 'px-1.5 pt-1.5 pb-0.5' : ''}>
                                  <span className="whitespace-pre-wrap">{msg.text}</span>
                                  <span className="inline-flex items-center gap-1 float-right ml-2.5 mt-1.5 translate-y-0.5 select-none">
                                    <span className="text-[11px] font-mono-tabular text-[#667781] dark:text-[#8696A0]">
                                      {formatMessageTime(msg.timestamp)}
                                    </span>
                                    {isMine && <StatusTicks status={msg.status} />}
                                  </span>
                                </div>
                              )}
                            </div>

                            {/* Selected Reactions Display Below Specific Message Bubble */}
                            {reactionGroups.length > 0 && (
                              <div
                                className={`mt-1 flex flex-wrap items-center gap-1 ${
                                  isMine ? 'justify-end' : 'justify-start'
                                }`}
                              >
                                {reactionGroups.map(({ emoji, users }) => {
                                  const reactedByMe = users.includes(currentUser.id);
                                  const reactorNames = users
                                    .map((uid) =>
                                      uid === currentUser.id ? 'You' : getPeerDisplayName(uid)
                                    )
                                    .join(', ');

                                  return (
                                    <button
                                      key={emoji}
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleToggleReaction(msg.id, emoji);
                                      }}
                                      title={`${reactorNames}${reactedByMe ? ' (click to remove)' : ' (click to react)'}`}
                                      aria-label={`${emoji} reaction by ${reactorNames}`}
                                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-xs border shadow-[0_1px_0.5px_rgba(11,20,26,0.08)] transition-colors cursor-pointer ${
                                        reactedByMe
                                          ? 'bg-[#E7FCE3] dark:bg-[#0A332C] border-[#00A884]/50 text-[#111B21] dark:text-[#E9EDEF]'
                                          : 'bg-white dark:bg-[#202C33] border-[#E9EDEF] dark:border-[#2A3942] text-[#111B21] dark:text-[#E9EDEF] hover:bg-[#F5F6F6] dark:hover:bg-[#2A3942]'
                                      }`}
                                    >
                                      <span className="text-sm leading-none">{emoji}</span>
                                      {users.length > 1 && (
                                        <span className="text-[11px] font-medium font-mono-tabular text-[#54656F] dark:text-[#AEBAC1]">
                                          {users.length}
                                        </span>
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </div>
                      </React.Fragment>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              {storageWarning && (
                <div className="px-4 py-2 bg-[#FEF2F2] dark:bg-[#2A1515] border-t border-[#FECACA] dark:border-[#7F1D1D] text-xs text-[#DC2626] dark:text-[#FCA5A5] flex items-center justify-between gap-2 shrink-0">
                  <span>{storageWarning}</span>
                  <button
                    type="button"
                    onClick={() => setStorageWarning('')}
                    aria-label="Dismiss storage warning"
                    className="p-1 hover:opacity-75 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* Message Composer */}
              <footer className="relative px-3 py-2.5 bg-[#F0F2F5] dark:bg-[#202C33] border-t border-[#E9EDEF] dark:border-[#222E35] flex items-end gap-1.5 sm:gap-2 shrink-0">
                {showEmojiPicker && (
                  <div className="absolute bottom-16 left-3 bg-white dark:bg-[#233138] border border-[#E9EDEF] dark:border-[#2A3942] rounded-xl shadow-lg p-2.5 grid grid-cols-8 gap-1 z-30">
                    {QUICK_EMOJIS.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        onClick={() => {
                          setDraftText((prev) => prev + emoji);
                          textareaRef.current?.focus();
                        }}
                        className="w-9 h-9 rounded-md hover:bg-[#F0F2F5] dark:hover:bg-[#2A3942] flex items-center justify-center text-lg cursor-pointer transition-colors"
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => setShowEmojiPicker((v) => !v)}
                  aria-label="Toggle emoji picker"
                  className="min-w-[44px] min-h-[44px] rounded-full flex items-center justify-center text-[#54656F] dark:text-[#8696A0] hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer shrink-0"
                >
                  <Smile className="w-6 h-6" />
                </button>

                <button
                  type="button"
                  onClick={handleOpenCameraModal}
                  title="Take photo with camera"
                  aria-label="Take photo with camera"
                  className="min-w-[44px] min-h-[44px] rounded-full flex items-center justify-center text-[#54656F] dark:text-[#8696A0] hover:bg-black/5 dark:hover:bg-white/10 hover:text-[#00A884] transition-colors cursor-pointer shrink-0"
                >
                  <Camera className="w-5 h-5" />
                </button>

                <div className="flex-1 bg-white dark:bg-[#2A3942] rounded-xl px-3.5 py-2 flex items-center min-h-[44px]">
                  <textarea
                    ref={textareaRef}
                    rows={1}
                    value={draftText}
                    onChange={handleTextareaChange}
                    onKeyDown={handleComposerKeyDown}
                    placeholder="Type a message"
                    className="w-full max-h-[120px] resize-none bg-transparent text-[15px] text-[#111B21] dark:text-[#E9EDEF] placeholder-[#667781] dark:placeholder-[#8696A0] focus:outline-none leading-snug"
                  />
                </div>

                <button
                  type="button"
                  onClick={handleSendMessage}
                  disabled={!draftText.trim()}
                  aria-label="Send message"
                  className={`min-w-[44px] min-h-[44px] rounded-full flex items-center justify-center transition-colors shrink-0 ${
                    draftText.trim()
                      ? 'bg-[#00A884] hover:bg-[#008F72] text-white cursor-pointer'
                      : 'text-[#8696A0] bg-transparent cursor-not-allowed'
                  }`}
                >
                  <Send className="w-5 h-5 translate-x-0.5" />
                </button>
              </footer>
            </>
          ) : (
            /* Empty Desktop Workspace When No Chat Is Selected */
            <div className="flex-1 bg-[#F0F2F5] dark:bg-[#222E35] flex flex-col items-center justify-center p-8 text-center border-b-[6px] border-[#00A884]">
              <div className="w-20 h-20 rounded-full bg-[#00A884]/12 dark:bg-[#00A884]/15 flex items-center justify-center text-[#00A884] mb-6">
                <MessageSquare className="w-10 h-10" />
              </div>
              <h2 className="text-2xl font-semibold text-[#111B21] dark:text-[#E9EDEF] tracking-tight">
                Welcome, {currentUser.displayName}
              </h2>
              <p className="mt-2.5 text-sm text-[#54656F] dark:text-[#8696A0] max-w-md leading-relaxed">
                Select an existing conversation from the left panel, or start a new chat by searching for registered users or adding a new contact. Offline messages are preserved automatically.
              </p>
              <button
                type="button"
                onClick={() => {
                  setSidebarView('new-chat');
                  setDirectorySearch('');
                }}
                className="mt-6 px-5 py-2.5 rounded-lg bg-[#00A884] hover:bg-[#008F72] text-white text-sm font-medium transition-colors flex items-center gap-2 whitespace-nowrap cursor-pointer min-h-[44px]"
              >
                <MessageSquarePlus className="w-4 h-4" />
                <span>Start a new chat</span>
              </button>
            </div>
          )}
        </main>
      </div>

      {/* Camera API Capture & Preview Modal */}
      <AnimatePresence>
        {cameraModalOpen && (
          <motion.div
            key="camera-modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6"
            onClick={handleCloseCameraModal}
          >
            <motion.div
              key="camera-modal-card"
              initial={{ opacity: 0, scale: 0.96, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 12 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-xl bg-[#111B21] text-white rounded-2xl overflow-hidden shadow-2xl border border-white/10 flex flex-col"
            >
              {/* Modal Header */}
              <div className="px-4 py-3 bg-[#202C33] flex items-center justify-between gap-3 border-b border-white/10">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Camera className="w-5 h-5 text-[#00A884] shrink-0" />
                  <h3 className="text-sm sm:text-base font-semibold truncate">
                    {capturedImageBase64
                      ? `Send photo to ${activePeerId ? getPeerDisplayName(activePeerId) : 'chat'}`
                      : 'Take a photo'}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={handleCloseCameraModal}
                  aria-label="Close camera"
                  className="min-w-[40px] min-h-[40px] rounded-full flex items-center justify-center text-[#AEBAC1] hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Hidden File Input Fallback */}
              <input
                ref={cameraFileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handleFallbackFileChange}
                className="hidden"
              />

              {/* Viewfinder OR Captured Image Preview */}
              <div className="relative bg-black aspect-video sm:aspect-[4/3] max-h-[60dvh] flex items-center justify-center overflow-hidden">
                {capturedImageBase64 ? (
                  <img
                    src={capturedImageBase64}
                    alt="Captured preview"
                    className="w-full h-full object-contain bg-black"
                  />
                ) : cameraStatus === 'error' ? (
                  <div className="px-6 py-8 text-center max-w-sm space-y-4">
                    <div className="w-14 h-14 mx-auto rounded-full bg-white/10 flex items-center justify-center text-[#00A884]">
                      <Camera className="w-7 h-7" />
                    </div>
                    <p className="text-sm text-[#E9EDEF] leading-relaxed">{cameraError}</p>
                    <div className="flex flex-wrap items-center justify-center gap-2.5">
                      <button
                        type="button"
                        onClick={() => cameraFileInputRef.current?.click()}
                        className="px-4 py-2.5 rounded-lg bg-[#00A884] hover:bg-[#008F72] text-white text-sm font-medium flex items-center gap-2 whitespace-nowrap cursor-pointer min-h-[44px]"
                      >
                        <Upload className="w-4 h-4" />
                        <span>Choose or capture image</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setCameraError('');
                          setCameraFacingMode((m) => (m === 'user' ? 'environment' : 'user'));
                        }}
                        className="px-4 py-2.5 rounded-lg bg-white/10 hover:bg-white/15 text-white text-sm font-medium whitespace-nowrap cursor-pointer min-h-[44px]"
                      >
                        Retry camera
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <video
                      ref={cameraVideoRef}
                      autoPlay
                      playsInline
                      muted
                      className={`w-full h-full object-cover ${
                        cameraFacingMode === 'user' ? '-scale-x-100' : ''
                      }`}
                    />
                    {cameraStatus === 'starting' && (
                      <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-2 text-sm text-[#AEBAC1]">
                        <Camera className="w-7 h-7 text-[#00A884]" />
                        <span>Starting camera...</span>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Modal Footer Controls */}
              {capturedImageBase64 ? (
                <form
                  onSubmit={handleSendCapturedImage}
                  className="p-3 sm:p-4 bg-[#202C33] border-t border-white/10 flex items-center gap-2.5"
                >
                  <button
                    type="button"
                    onClick={() => setCapturedImageBase64(null)}
                    aria-label="Retake photo"
                    title="Retake photo"
                    className="px-3.5 min-h-[44px] rounded-xl bg-white/10 hover:bg-white/15 text-sm font-medium text-white flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <RotateCcw className="w-4 h-4" />
                    <span>Retake</span>
                  </button>

                  <input
                    type="text"
                    value={imageCaption}
                    onChange={(e) => setImageCaption(e.target.value)}
                    placeholder="Add a caption..."
                    className="flex-1 min-w-0 h-[44px] px-3.5 rounded-xl bg-[#2A3942] text-sm text-white placeholder-[#8696A0] focus:outline-none focus:ring-1 focus:ring-[#00A884]"
                  />

                  <button
                    type="submit"
                    aria-label="Send photo"
                    className="min-w-[44px] min-h-[44px] px-4 rounded-xl bg-[#00A884] hover:bg-[#008F72] text-white text-sm font-medium flex items-center justify-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Send className="w-4 h-4" />
                    <span className="hidden sm:inline">Send</span>
                  </button>
                </form>
              ) : (
                <div className="px-4 py-3.5 bg-[#202C33] border-t border-white/10 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => cameraFileInputRef.current?.click()}
                    title="Upload image instead"
                    aria-label="Upload image instead"
                    className="min-h-[44px] px-3 rounded-xl bg-white/10 hover:bg-white/15 text-xs sm:text-sm font-medium text-[#E9EDEF] flex items-center gap-2 whitespace-nowrap cursor-pointer"
                  >
                    <Upload className="w-4 h-4" />
                    <span>Upload</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleCapturePhoto}
                    disabled={cameraStatus !== 'ready'}
                    aria-label="Capture photo"
                    className={`w-14 h-14 rounded-full border-4 border-white flex items-center justify-center transition-transform ${
                      cameraStatus === 'ready'
                        ? 'bg-[#00A884] hover:bg-[#008F72] active:scale-95 cursor-pointer shadow-lg'
                        : 'bg-white/20 opacity-50 cursor-not-allowed'
                    }`}
                  >
                    <Camera className="w-6 h-6 text-white" />
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setCameraFacingMode((mode) =>
                        mode === 'user' ? 'environment' : 'user'
                      )
                    }
                    title="Switch camera"
                    aria-label="Switch front or back camera"
                    className="min-h-[44px] px-3 rounded-xl bg-white/10 hover:bg-white/15 text-xs sm:text-sm font-medium text-[#E9EDEF] flex items-center gap-2 whitespace-nowrap cursor-pointer"
                  >
                    <RefreshCw className="w-4 h-4" />
                    <span className="hidden sm:inline">Flip</span>
                  </button>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Fullscreen Image Lightbox */}
      <AnimatePresence>
        {lightboxImage && (
          <motion.div
            key="lightbox-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={() => setLightboxImage(null)}
            className="fixed inset-0 z-50 bg-black/90 flex flex-col p-4 sm:p-6"
          >
            <div
              className="flex items-center justify-between gap-3 text-white mb-3"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">{lightboxImage.senderName}</div>
                <div className="text-xs text-[#AEBAC1] font-mono-tabular">
                  {formatDateSeparator(lightboxImage.timestamp)} at{' '}
                  {formatMessageTime(lightboxImage.timestamp)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setLightboxImage(null)}
                aria-label="Close photo viewer"
                className="min-w-[44px] min-h-[44px] rounded-full flex items-center justify-center bg-white/10 hover:bg-white/20 text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 min-h-0 flex items-center justify-center">
              <img
                src={lightboxImage.src}
                alt={lightboxImage.caption || 'Shared photo'}
                onClick={(e) => e.stopPropagation()}
                className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
              />
            </div>

            {lightboxImage.caption && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="mt-3 text-center text-sm text-white/95 max-w-2xl mx-auto px-4 py-2 rounded-lg bg-white/10"
              >
                {lightboxImage.caption}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    </MotionConfig>
  );
}
