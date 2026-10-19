import React, { useEffect, useRef, useState } from "react";
import { reaction } from "mobx";
import { observer } from "mobx-react";
import { useLoadingRoute } from "react-navi";
import {
  Menu,
  Button,
  Dropdown,
  Container,
  Icon,
  Message,
  Ref,
  Segment,
  Sidebar,
  SemanticICONS
} from "semantic-ui-react";

import "fomantic-ui-css/components/site.css";
import "noty/src/themes/semanticui.scss";

import style from "./AppLayout.module.less";

import GlobalProgressBar from "@/components/GlobalProgressBar";
import ReauthenticationHost from "@/components/ReauthenticationDialog";
import SiteFooterBranding from "@/components/SiteFooterBranding";

import { Locale } from "@/interfaces/Locale";
import localeMeta from "@/locales/meta";
import { appState } from "@/appState";
import {
  useLocalizer,
  useLoginOrRegisterNavigation,
  useScreenWidthWithin,
  useNavigationChecked,
  Link
} from "@/utils/hooks";
import toast from "@/utils/toast";
import api from "@/api";
import formatDateTime from "@/utils/formatDateTime";
import { EmojiRenderer } from "@/components/EmojiRenderer";
import { detailPreviewCloseMessage, detailPreviewFocusMessage, embeddedDetailMode } from "@/utils/embeddedDetail";
import { actsAsButton, installKeyboardMenus, keyboardMenu } from "@/utils/keyboard";
import { announce, initAnnouncer } from "@/utils/announce";

export type NavButtonName =
  | "home"
  | "problem_set"
  | "study_lists"
  | "contests"
  | "submissions"
  | "hacks"
  | "members"
  | "discussion"
  | "teams"
  | "solutions";

let AppLayout: React.FC<React.PropsWithChildren> = props => {
  const navigation = useNavigationChecked();
  const loadingRoute = useLoadingRoute();
  const _ = useLocalizer("common");

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const refMain = useRef<HTMLElement>();
  const refMenuButton = useRef<HTMLElement>();
  const refSidebar = useRef<HTMLElement>();

  useEffect(() => {
    initAnnouncer();
    installKeyboardMenus();
  }, []);

  // After moving to another page without reloading, start reading and tabbing from the new page's content, as a
  // full page load would, and say which page it is once the page has set its title.
  useEffect(() => {
    let lastPathname = location.pathname;
    let titlePending = false,
      fallback: ReturnType<typeof setTimeout>;
    const announceTitle = () => {
      if (!titlePending) return;
      titlePending = false;
      clearTimeout(fallback);
      // As App.tsx sets it; document.title itself is only updated a little later
      announce((appState.title ? appState.title + " - " : "") + appState.serverPreference.siteName);
    };
    const disposeReaction = reaction(
      () => appState.title,
      () => setTimeout(announceTitle, 0)
    );
    const subscription = navigation.subscribe(route => {
      if (route.type !== "ready" || embeddedDetailMode || route.url.pathname === lastPathname) return;
      lastPathname = route.url.pathname;
      refMain.current?.focus({ preventScroll: true });
      titlePending = true;
      clearTimeout(fallback);
      fallback = setTimeout(announceTitle, 1000);
    });
    return () => {
      subscription.unsubscribe();
      disposeReaction();
      clearTimeout(fallback);
    };
  }, []);

  // The narrow-screen menu: focus its first item when it opens, Escape closes it and returns to its button
  useEffect(() => {
    if (!sidebarOpen) return;
    refSidebar.current?.querySelector<HTMLElement>("a[href], button, [tabindex='0']")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSidebarOpen(false);
      refMenuButton.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sidebarOpen]);

  useEffect(() => {
    if (!embeddedDetailMode) return;
    document.documentElement.classList.add(style.embeddedDetail);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Tab") return;
      const overlayOpen = Array.from(
        document.querySelectorAll<HTMLElement>(".ui.modal,.ui.dropdown.active,.ui.popup.visible")
      ).some(element => element.getClientRects().length > 0);
      // Let the original page close its own Hack dialogs, confirmations and dropdowns first.
      if (overlayOpen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        window.parent.postMessage({ type: detailPreviewCloseMessage }, window.location.origin);
      } else {
        const focusable = Array.from(
          document.querySelectorAll<HTMLElement>(
            'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]'
          )
        ).filter(element => element.getClientRects().length > 0);
        const first = focusable[0],
          last = focusable[focusable.length - 1];
        if (
          (!event.shiftKey && document.activeElement === last) ||
          (event.shiftKey && document.activeElement === first)
        ) {
          event.preventDefault();
          window.parent.postMessage(
            { type: detailPreviewFocusMessage, direction: event.shiftKey ? "previous" : "next" },
            window.location.origin
          );
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.documentElement.classList.remove(style.embeddedDetail);
    };
  }, []);

  useEffect(() => {
    if (sidebarOpen !== document.documentElement.classList.contains(style.sidebarOpen))
      document.documentElement.classList.toggle(style.sidebarOpen);
  }, [sidebarOpen]);

  useEffect(() => {
    const subscription = navigation.subscribe(route => {
      if (route.type === "ready") {
        setSidebarOpen(false);
      }
    });

    return () => subscription.unsubscribe();
  });

  async function onLogoutClick() {
    const { requestError, response } = await api.auth.logout();
    if (requestError) {
      toast.error(requestError(_));
    } else {
      appState.token = null;
      appState.logout = true;
      location.reload();
    }
  }

  const onLoginOrRegisterClick = useLoginOrRegisterNavigation();

  const navButtons: Record<
    Exclude<NavButtonName, "teams" | "solutions" | "members">,
    { icon: SemanticICONS; text: string; url?: string }
  > = {
    home: {
      icon: "home",
      text: ".navbar.home",
      url: "/"
    },
    problem_set: {
      icon: "book",
      text: ".navbar.problem_set",
      url: "/p"
    },
    study_lists: { icon: "list", text: ".navbar.study_lists", url: "/study-lists" },
    contests: { icon: "trophy", text: ".navbar.contests", url: "/contests" },
    submissions: {
      icon: "hourglass",
      text: ".navbar.submissions",
      url: "/s"
    },
    hacks: { icon: "bug", text: ".navbar.hacks", url: "/hacks" },
    discussion: {
      icon: "comments",
      text: ".navbar.discussion",
      url: "/d"
    }
  };

  const navMenuItems = Object.keys(navButtons).map(name => (
    <Menu.Item key={name} as={Link} href={navButtons[name].url} active={appState.activeNavButton === name}>
      <Icon name={navButtons[name].icon} />
      {_(navButtons[name].text)}
    </Menu.Item>
  ));

  const loginAndRegisterButtons = (
    <>
      <Button className={style.loginAndRegisterButton} onClick={() => onLoginOrRegisterClick("login")}>
        {_(".header.user.login")}
      </Button>
      {appState.serverPreference.security.registrationMode !== "closed" && (
        <Button className={style.loginAndRegisterButton} primary onClick={() => onLoginOrRegisterClick("register")}>
          {_(".header.user.register")}
        </Button>
      )}
    </>
  );

  const userMenu = () => (
    <>
      <Dropdown.Menu className={style.userMenu}>
        <Dropdown.Item as={Link} href={`/u/${appState.currentUser.username}`}>
          <Icon name="user" />
          {_(".header.user.profile")}
        </Dropdown.Item>
        <Dropdown.Item as={Link} href={{ pathname: "/s", query: { submitter: appState.currentUser.username } }}>
          <Icon name="hourglass half" />
          {_(".header.user.submissions")}
        </Dropdown.Item>
        {appState.currentUserHasPrivilege("ViewHack") && (
          <Dropdown.Item as={Link} href="/hacks?mine=1">
            <Icon name="bug" />
            {_(".header.user.hacks")}
          </Dropdown.Item>
        )}
        <Dropdown.Item as={Link} href={{ pathname: "/p", query: { ownerId: appState.currentUser.id } }}>
          <Icon name="book" />
          {_(".header.user.problems")}
        </Dropdown.Item>
        <Dropdown.Item as={Link} href={{ pathname: "/d", query: { publisherId: appState.currentUser.id } }}>
          <Icon name="comments" />
          {_(".header.user.discussions")}
        </Dropdown.Item>
        <Dropdown.Item as={Link} href="/teams?mine=1">
          <Icon name="users" />
          {_(".header.user.teams")}
        </Dropdown.Item>
        {appState.currentUserHasPrivilege("ManageSummaries") && (
          <Dropdown.Item as={Link} href="/summaries">
            <Icon name="file alternate outline" />
            {_(".header.user.summaries")}
          </Dropdown.Item>
        )}
        {appState.currentUserJoinedGroupsCount > 0 && (
          <Dropdown.Item as={Link} href="/groups">
            <Icon name="users" />
            {_(".header.user.groups")}
          </Dropdown.Item>
        )}
        {Dropdown === Dropdown && <Dropdown.Divider />}
        <Dropdown.Item as={Link} href={`/u/${appState.currentUser.username}/edit/profile`}>
          <Icon name="edit" />
          {_(".header.user.edit_profile")}
        </Dropdown.Item>
        <Dropdown.Item as={Link} href={`/u/${appState.currentUser.username}/edit/preference`}>
          <Icon name="cog" />
          {_(".header.user.preference")}
        </Dropdown.Item>
        {appState.currentUser.isAdmin && (
          <Dropdown.Item as={Link} href="/site-management">
            <Icon name="settings" />
            {_(".header.user.site_management")}
          </Dropdown.Item>
        )}
        {appState.currentUser.isAdmin && (
          <Dropdown.Item as={Link} href="/permissions">
            <Icon name="shield alternate" />
            {_(".header.user.permissions")}
          </Dropdown.Item>
        )}
        {appState.currentUserHasPrivilege("ViewSite") && appState.currentUserHasPrivilege("ManageRegistrationReviews") && (
          <Dropdown.Item as={Link} href="/registration-reviews">
            <Icon name="users" />
            {_(".header.user.registration_reviews")}
          </Dropdown.Item>
        )}
        {appState.currentUserHasPrivilege("ManageAiConfiguration") && (
          <Dropdown.Item as={Link} href="/ai/configuration">
            <Icon name="settings" />
            {_(".header.user.ai_configuration")}
          </Dropdown.Item>
        )}
        <Dropdown.Item {...actsAsButton} onClick={onLogoutClick}>
          <Icon name="power" />
          {_(".header.user.logout")}
        </Dropdown.Item>
      </Dropdown.Menu>
    </>
  );

  const logo = (
    <Menu.Item as={Link} href="/" className={style.logoItem}>
      <div className={style.content}>
        {appState.appLogoThemed && (
          <div className={style.logo}>
            <img {...appState.appLogoThemed} />
          </div>
        )}
        <EmojiRenderer>
          <div className={style.siteName}>{appState.serverPreference.siteName}</div>
        </EmojiRenderer>
      </div>
    </Menu.Item>
  );

  const getFooter = (className: string, placeholder = false) => (
    <>
      <Segment
        as={placeholder ? "div" : "footer"}
        vertical
        className={className}
        aria-hidden={placeholder || undefined}
      >
        <Container textAlign="center">
          <EmojiRenderer>
            <SiteFooterBranding
              siteName={appState.serverPreference.siteName}
              copyrightNotice={appState.serverPreference.copyrightNotice}
            />
          </EmojiRenderer>
          <div id={style.footerVersion} className="monospace">
            <span>
              F: <span title={formatDateTime(window.appVersion.date)[1]}>{window.appVersion.hash}</span>
            </span>
            &nbsp;/&nbsp;
            <span>
              B: <span title={formatDateTime(appState.serverVersion.date)[1]}>{appState.serverVersion.hash}</span>
            </span>
          </div>
          <div className={style.footerIcons}>
            <Link href="/judge-machine" title={_(".footer.judge_machine")}>
              <Icon name="server" />
            </Link>
            <Dropdown {...keyboardMenu} icon="language" title={_(".footer.locale")} aria-label={_(".footer.locale")}>
              <Dropdown.Menu className={style.languageSwitchMenu}>
                {Object.keys(localeMeta).map((locale: Locale) => (
                  <Dropdown.Item
                    key={locale}
                    onClick={() => {
                      appState.localLocale = locale;
                      navigation.refresh();
                    }}
                    flag={localeMeta[locale].flag}
                    text={localeMeta[locale].name}
                    value={locale}
                    selected={locale === appState.locale}
                  />
                ))}
              </Dropdown.Menu>
            </Dropdown>
            <Link
              href="https://github.com/houyhlouis/LLMOJ"
              title={_(".footer.github")}
              target="_blank"
              rel="noreferrer noopener"
            >
              <Icon name="github" />
            </Link>
          </div>
        </Container>
      </Segment>
    </>
  );

  const userDropdown = (icon = true) => (
    <Menu.Menu position="right">
      <Dropdown
        simple
        item
        open={false}
        icon={icon && <i className="dropdown icon"></i>}
        text={appState.currentUser.username}
        aria-label={_(".header.user.menu", { username: appState.currentUser.username })}
      >
        {userMenu()}
      </Dropdown>
    </Menu.Menu>
  );

  const topBarItemsForWideScreen = (
    <>
      {navMenuItems}
      {appState.currentUser ? (
        userDropdown()
      ) : (
        <Menu.Item className={style.userContainer}>{loginAndRegisterButtons}</Menu.Item>
      )}
    </>
  );

  const topBarItemsForNarrowScreen = (
    <Menu.Menu position="right">
      {appState.currentUser && userDropdown(false)}
      <Ref innerRef={refMenuButton}>
        <Menu.Item
          {...actsAsButton}
          icon="bars"
          aria-label={_(".header.open_menu")}
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen(true)}
        />
      </Ref>
    </Menu.Menu>
  );

  const wide = useScreenWidthWithin(1280, Infinity);

  const sidebarOpenStatusClassName = sidebarOpen ? " " + style.sidebarOpen : "";

  return (
    <>
      {!embeddedDetailMode && (
        <a
          href={"#" + style.mainUiContainer}
          className={style.skipLink}
          onClick={event => {
            event.preventDefault();
            refMain.current?.focus();
          }}
        >
          {_(".skip_to_content")}
        </a>
      )}
      <GlobalProgressBar isAnimating={!!loadingRoute} />
      {!embeddedDetailMode && (
        <Menu as="nav" borderless fixed="top" className={style.menu} aria-label={_(".main_navigation")}>
          <Container id={style.mainMenuContainer}>
            {logo}
            {wide ? topBarItemsForWideScreen : topBarItemsForNarrowScreen}
          </Container>
        </Menu>
      )}
      <Ref innerRef={refMain}>
        <Container as="main" id={style.mainUiContainer} tabIndex={-1} aria-busy={!!loadingRoute}>
          {appState.sessionEnded && !appState.token && (
            <Message warning role="status" onDismiss={() => (appState.sessionEnded = false)}>
              {_(".session_ended.message")}{" "}
              <Button size="mini" primary compact onClick={() => onLoginOrRegisterClick("login")}>
                {_(".session_ended.sign_in")}
              </Button>
            </Message>
          )}
          {props.children}
        </Container>
      </Ref>
      <ReauthenticationHost />
      {getFooter(style.footer + " " + style.placeholder, true)}
      {getFooter(style.footer + " " + style.real)}
      {!wide && !embeddedDetailMode && (
        <>
          <div className={style.sidebarDimmer + sidebarOpenStatusClassName} onClick={() => setSidebarOpen(false)}></div>
          <Ref innerRef={refSidebar}>
            <Sidebar
              as={Menu}
              className={style.sidebarMenu + sidebarOpenStatusClassName}
              animation="push"
              direction="right"
              vertical
              visible
              aria-label={_(".site_menu")}
            >
              <Menu.Item className={style.siteName} as={Link} href="/">
                {appState.serverPreference.siteName}
              </Menu.Item>
              {!appState.currentUser && (
                <Menu.Item>
                  <Button.Group fluid>{loginAndRegisterButtons}</Button.Group>
                </Menu.Item>
              )}
              {navMenuItems}
            </Sidebar>
          </Ref>
        </>
      )}
    </>
  );
};

AppLayout = observer(AppLayout);

export default AppLayout;
