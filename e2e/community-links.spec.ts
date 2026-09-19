import { expect, test } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  type ElectronTestHarness,
} from "./electronTestHarness";

let harness: ElectronTestHarness | undefined;

test.beforeAll(async () => {
  harness = await launchElectronTestHarness("community-links-");
});

test.afterAll(async () => {
  await closeElectronTestHarness(harness);
  harness = undefined;
});

test.describe("community links", () => {
  test("sit under Feedback and open in the browser", async () => {
    const page = harness!.page;
    const sidebar = page.locator("#sidebar");
    await expect(sidebar).toBeVisible({ timeout: 90_000 });

    const discord = sidebar.locator('[data-community-link="discord"]');
    const patreon = sidebar.locator('[data-community-link="patreon"]');
    await expect(discord).toBeVisible();
    await expect(patreon).toBeVisible();

    // Both sit below the Feedback button, which is what the row is anchored to.
    const feedback = sidebar.locator("[data-feedback-open]");
    const feedbackBox = await feedback.boundingBox();
    const discordBox = await discord.boundingBox();
    const patreonBox = await patreon.boundingBox();
    expect(discordBox!.y).toBeGreaterThan(feedbackBox!.y);
    expect(patreonBox!.y).toBeGreaterThan(feedbackBox!.y);
    // Side by side while the sidebar is expanded, and evenly split.
    expect(Math.abs(discordBox!.y - patreonBox!.y)).toBeLessThan(2);
    expect(Math.abs(discordBox!.width - patreonBox!.width)).toBeLessThan(2);

    await sidebar.screenshot({ path: test.info().outputPath("community-links-expanded.png") });

    await sidebar.locator("[data-sidebar-collapse]").click();
    await expect(sidebar).toHaveClass(/sidebar-collapsed/);
    const stackedDiscord = await discord.boundingBox();
    const stackedPatreon = await patreon.boundingBox();
    // The collapsed rail is one icon wide, so the pair stacks instead of clipping.
    expect(stackedPatreon!.y).toBeGreaterThan(stackedDiscord!.y);
    expect(stackedDiscord!.x + stackedDiscord!.width).toBeLessThanOrEqual(
      (await sidebar.boundingBox())!.width + 1,
    );
    await sidebar.screenshot({ path: test.info().outputPath("community-links-collapsed.png") });
  });
});
