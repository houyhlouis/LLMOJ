# Keyboard and screen readers

[简体中文](Accessibility.zh-CN.md) | English | [Wiki home](Home.en.md)

LLMOJ's pages work with a keyboard alone, and screen readers are told what changes on them. This page lists the keys and what you'll see or hear.

## Moving around

- **Skip to main content:** the first Tab on a page shows this link. Press Enter to go past the menus to the page's content.
- **Opening another page:** the focus moves to the new page's content, as after a full page load, and screen readers hear the page's title.
- **Menus with items:** these include the language menu at the bottom of the page and the **⋯** and **+** menus. Tab to the menu, then:
  - **↓** and **↑** move through its items;
  - **Enter** or **Space** chooses the item;
  - **Escape** closes the menu.
- **Your account menu** (your username at the top) opens while you Tab through its items.
- **Narrow screens:** the **☰** button opens the site menu, and the focus moves into it. Escape closes it and returns to the button.
- **Small icon buttons** (remove a filter, download, delete, rename) are reached with Tab and pressed with Enter or Space. Screen readers read their names.

## Signing in

- The sign-in page starts in the name field. It doesn't on touch screens, where that would cover the page with the keyboard.
- Tab goes from the name to the password, and Enter signs in. **Forgot password** comes after the password field.
- A wrong name or password is read out and tied to its field.
- On the register and reset-password pages, Tab also reaches **Send**, which sends the verification code.

## Submitting code

1. On a problem page, Tab to **Submit** in the menu on the right and press Enter. The code editor gets the focus.
2. In the code editor, Tab indents. To leave the editor, press **Ctrl+M** (**⌃⇧M** on a Mac): Tab then moves to the language and the **Submit** button. Press it again to indent with Tab. A hint at the bottom of the editor says which mode is on.
3. **Back to Statement** returns to the problem, with the focus back on **Submit**.

## Live updates

While a submission is being judged, its page and the submission list update live:

- **The connection drops:** a notice says **Live updates are interrupted. Reconnecting…** It retries by itself.
- **Several attempts fail:** the notice says the page may be out of date and offers **Reload page**.
- **The connection is back:** the notice disappears, and screen readers hear "Live updates resumed".
- **Judging finishes while the page is open:** screen readers hear the result, for example "Judging finished: Accepted, score 100."
- **Notifications** at the top right are read out too. Errors are read out at once.

## Phones and zoom

You can pinch to zoom on every page. On phones, text fields use 16-pixel text, so iPhones don't zoom in when you tap one. Sign-in, the problem set, problem pages and submissions fit screens 320 to 768 pixels wide without scrolling sideways.

## Known limits

- **Contrast:** some of Semantic UI's colors are a little under the 4.5:1 contrast that WCAG asks of small text. These include links, blue buttons and status colors.
- **Dropdowns:** screen readers announce them as list boxes, because of Semantic UI's markup.
- **Headings:** some list pages have no top-level heading. Their title is in the browser tab and is read out when the page opens.
