import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { Icon, Modal } from "semantic-ui-react";

import style from "./SubmissionPreview.module.less";

import { appState } from "@/appState";
import { Locale } from "@/interfaces/Locale";
import { Link, useLocalizer, useNavigationChecked } from "@/utils/hooks";
import { detailPreviewCloseMessage, detailPreviewFocusMessage, embeddedDetailMode } from "@/utils/embeddedDetail";

interface PreviewTarget {
  kind: "submission" | "hack";
  id: number;
  href: string;
  frameHref: string;
}

const PreviewContext = createContext<(target: PreviewTarget) => void>(null);

function detailTarget(kind: PreviewTarget["kind"], id: number, href: string): PreviewTarget | null {
  if (!href || !Number.isSafeInteger(id) || id < 1) return null;
  try {
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin || url.username || url.password) return null;
    const allowed =
      kind === "hack" ? /^\/hacks\/([1-9]\d*)\/?$/ : /^(?:\/s|\/contest\/[1-9]\d*\/submission)\/([1-9]\d*)\/?$/;
    const matched = allowed.exec(url.pathname);
    if (!matched || Number(matched[1]) !== id) return null;
    url.searchParams.delete("embed");
    const originalHref = url.pathname + url.search + url.hash;
    url.searchParams.set("embed", "1");
    return { kind, id, href: originalHref, frameHref: url.pathname + url.search + url.hash };
  } catch {
    return null;
  }
}

// Preserve real URLs for modified clicks, new tabs, copy-link and the iframe itself.
function DetailPreviewLink({
  kind,
  id,
  href,
  className,
  children
}: React.PropsWithChildren<{ kind: PreviewTarget["kind"]; id: number; href: string; className?: string }>) {
  const open = useContext(PreviewContext);
  return (
    <Link
      href={href}
      className={className}
      {...(kind === "hack" ? { "data-hack-preview": id } : { "data-submission-preview": id })}
      onClick={event => {
        if (
          !open ||
          embeddedDetailMode ||
          event.defaultPrevented ||
          event.button !== 0 ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        const target = detailTarget(kind, id, href);
        if (!target) return;
        event.preventDefault();
        open(target);
      }}
    >
      {children}
    </Link>
  );
}

export function SubmissionPreviewLink({
  submissionId,
  href = `/s/${submissionId}`,
  className,
  children
}: React.PropsWithChildren<{
  submissionId: number;
  contestId?: number;
  href?: string;
  className?: string;
}>) {
  return (
    <DetailPreviewLink kind="submission" id={submissionId} href={href} className={className}>
      {children}
    </DetailPreviewLink>
  );
}

export function HackPreviewLink({
  hackId,
  href = `/hacks/${hackId}`,
  className,
  children
}: React.PropsWithChildren<{ hackId: number; href?: string; className?: string }>) {
  return (
    <DetailPreviewLink kind="hack" id={hackId} href={href} className={className}>
      {children}
    </DetailPreviewLink>
  );
}

export const DetailPreviewProvider = observer(function DetailPreviewProvider({ children }: React.PropsWithChildren) {
  const _ = useLocalizer("submission"),
    navigation = useNavigationChecked();
  const [target, setTarget] = useState<PreviewTarget>(null);
  const closeRef = useRef<HTMLButtonElement>(null),
    frameRef = useRef<HTMLIFrameElement>(null),
    headingRef = useRef<HTMLDivElement>(null);
  const session = `${appState.token || ""}:${appState.locale}`,
    openedSession = useRef(session);
  const visible = !!target && session === openedSession.current;

  useEffect(() => {
    if (session !== openedSession.current) {
      openedSession.current = session;
      setTarget(null);
    }
  }, [session]);

  useEffect(() => {
    const subscription = navigation.subscribe(route => {
      if (route.type === "ready") setTarget(null);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!target) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow) return;
      if (event.data?.type === detailPreviewCloseMessage) setTarget(null);
      else if (event.data?.type === detailPreviewFocusMessage) {
        if (event.data.direction === "previous") closeRef.current?.focus();
        else headingRef.current?.querySelector<HTMLAnchorElement>("a[href]")?.focus();
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || event.key !== "appState") return;
      try {
        const stored = JSON.parse(event.newValue || "{}");
        if ((stored.token || "") !== (appState.token || "")) {
          setTarget(null);
          return;
        }
        if (
          (stored.localLocale === null || Object.values(Locale).includes(stored.localLocale)) &&
          stored.localLocale !== appState.localLocale
        ) {
          appState.localLocale = stored.localLocale;
          setTarget(null);
          navigation.refresh();
        }
      } catch {
        setTarget(null);
      }
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("storage", onStorage);
    };
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const focused = document.activeElement as HTMLElement,
      previousHtmlOverflowY = document.documentElement.style.overflowY,
      previousOverflow = document.body.style.overflow,
      previousPadding = document.body.style.paddingRight,
      scrollX = window.scrollX,
      scrollY = window.scrollY,
      pageUrl = location.pathname + location.search,
      scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.documentElement.style.overflowY = "hidden";
    document.body.style.overflow = "hidden";
    if (scrollbarWidth) document.body.style.paddingRight = `${scrollbarWidth}px`;
    const focusTimer = setTimeout(() => closeRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      const modal = headingRef.current?.closest(".ui.modal");
      if (!modal) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setTarget(null);
      } else if (event.key === "Tab") {
        const focusable = Array.from(
          modal.querySelectorAll<HTMLElement>("a[href],button:not([disabled]),iframe")
        ).filter(element => element.getClientRects().length > 0);
        if (!focusable.length) return;
        const first = focusable[0],
          last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKeyDown, true);
      document.documentElement.style.overflowY = previousHtmlOverflowY;
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPadding;
      if (location.pathname + location.search === pageUrl) {
        window.scrollTo(scrollX, scrollY);
        if (focused?.isConnected) focused.focus({ preventScroll: true });
      }
    };
  }, [target]);

  if (embeddedDetailMode) return <>{children}</>;

  return (
    <PreviewContext.Provider value={setTarget}>
      {children}
      <Modal
        open={visible}
        onClose={() => setTarget(null)}
        closeOnEscape={false}
        className={style.preview}
        centered
        aria-labelledby="submission-preview-title"
      >
        <Modal.Header>
          <div ref={headingRef} className={style.heading}>
            <span id="submission-preview-title">
              {target?.kind === "hack" ? "Hack" : _(".title")} <Link href={target?.href}>#{target?.id}</Link>
            </span>
            <button
              ref={closeRef}
              type="button"
              className={style.close}
              aria-label={_(target?.kind === "hack" ? ".close_hack_preview" : ".close_preview")}
              onClick={() => setTarget(null)}
            >
              <Icon name="close" />
            </button>
          </div>
        </Modal.Header>
        <Modal.Content className={style.content}>
          {visible && (
            <iframe
              key={target.frameHref}
              ref={frameRef}
              className={style.frame}
              src={target.frameHref}
              title={`${target.kind === "hack" ? "Hack" : _(".title")} #${target.id}`}
            />
          )}
        </Modal.Content>
      </Modal>
    </PreviewContext.Provider>
  );
});

export const SubmissionPreviewProvider = DetailPreviewProvider;
