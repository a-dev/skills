import { expect, test } from "@playwright/test";

import { startReferenceServer } from "./reference-server.mjs";

test("development fixture proves themes, keyboard activation, loading, toggles, and DOM state", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");

  const save = page.getByRole("button", { name: "Save", exact: true });
  const pin = page.getByRole("button", { name: "Pin" });
  const disableSave = page.getByRole("checkbox", { name: "Disable save" });
  const complete = page.getByRole("button", { name: "Complete save" });
  const actionCount = page.getByTestId("save-action-count");

  await expect(save).toHaveAttribute("aria-pressed", "false");
  await expect(save).not.toHaveAttribute("data-loading");
  await expect(save).not.toHaveAttribute("aria-busy");
  await expect(save).toHaveClass(/caller-class/);
  await expect(save).toHaveCSS("--_progress", "0.6");
  await expect(actionCount).toHaveText("0");
  await expect(page.getByTestId("layer-probe")).toHaveCSS("color", "rgb(0, 128, 0)");
  await expect(page.getByTestId("composes-probe")).toHaveCSS("display", "flex");

  await expect(save).toHaveCSS("background-color", "rgb(0, 80, 220)");
  await page.locator("html").evaluate((element) => element.setAttribute("data-theme", "dark"));
  await expect(save).toHaveCSS("background-color", "rgb(80, 210, 255)");
  await page.locator("html").evaluate((element) => element.removeAttribute("data-theme"));
  await expect(save).toHaveCSS("background-color", "rgb(0, 80, 220)");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(save).toHaveCSS("background-color", "rgb(80, 210, 255)");
  await page.locator("html").evaluate((element) => element.setAttribute("data-theme", "light"));
  await expect(save).toHaveCSS("background-color", "rgb(0, 80, 220)");

  await page.locator("html").evaluate((element) => element.removeAttribute("data-theme"));
  await page.keyboard.press("Tab");
  await expect(disableSave).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(save).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(actionCount).toHaveText("1");
  await expect(save).toBeDisabled();
  await expect(save).toHaveAttribute("data-loading", "true");
  await expect(save).toHaveAttribute("aria-busy", "true");
  await expect(complete).toBeEnabled();

  // The button is disabled while loading, so a keyboard event cannot submit it again.
  await page.keyboard.press("Space");
  await expect(actionCount).toHaveText("1");
  await complete.click();
  await expect(save).toBeEnabled();
  await expect(save).not.toHaveAttribute("data-loading");
  await expect(save).not.toHaveAttribute("aria-busy");

  await save.focus();
  await page.keyboard.press("Space");
  await expect(actionCount).toHaveText("2");
  await expect(save).toBeDisabled();
  await complete.click();

  await disableSave.check();
  await expect(save).toBeDisabled();
  await save.evaluate((element) => element.click());
  await expect(actionCount).toHaveText("2");
  await disableSave.uncheck();
  await expect(save).toBeEnabled();

  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await pin.click();
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await expect(pin).toHaveCSS("box-shadow", /inset/);
});

test("reduced motion and forced colors are component rules with mutation controls", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
  await page.goto("/");

  const save = page.getByRole("button", { name: "Save", exact: true });
  const spinner = save.locator('[aria-hidden="true"]');
  await expect(spinner).toHaveCSS("animation-name", "none");
  await expect(save).toHaveCSS("--_forced-colors-indicator", "active");
  expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);

  const reducedControl = await startReferenceServer({
    mode: "development",
    port: 4174,
    removeReducedMotion: true,
  });
  try {
    await page.goto(`${reducedControl.url}/`);
    await expect(
      page.getByRole("button", { name: "Save", exact: true }).locator('[aria-hidden="true"]'),
    ).not.toHaveCSS("animation-name", "none");
  } finally {
    await reducedControl.close();
  }

  const forcedColorsControl = await startReferenceServer({
    mode: "development",
    port: 4174,
    removeForcedColors: true,
  });
  try {
    await page.goto(`${forcedColorsControl.url}/`);
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCSS(
      "--_forced-colors-indicator",
      "inactive",
    );
  } finally {
    await forcedColorsControl.close();
  }
});

test("production preview preserves composition and local precedence across import order", async ({
  page,
}) => {
  for (const reverseImportOrder of [false, true]) {
    const production = await startReferenceServer({
      mode: "production",
      port: 4174,
      reverseImportOrder,
    });
    try {
      await page.goto(`${production.url}/`);
      await expect(page.getByTestId("layer-probe")).toHaveCSS("color", "rgb(0, 128, 0)");
      await expect(page.getByTestId("composes-probe")).toHaveCSS("display", "flex");
    } finally {
      await production.close();
    }
  }
});
