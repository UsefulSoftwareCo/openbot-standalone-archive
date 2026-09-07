import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  getLoadedProjectIcon,
  loadProjectIconComponent,
  setIconImporterForTests,
} from "./projectIconLoader";

const BasketIcon = () => null;

afterEach(() => {
  setIconImporterForTests();
});

describe("loadProjectIconComponent", () => {
  it("resolves an icon's component and caches it for later renders", async () => {
    const importer = vi.fn(async (moduleName: string) => ({ [`${moduleName}Icon`]: BasketIcon }));
    setIconImporterForTests(importer);

    expect(getLoadedProjectIcon("Basket")).toBeNull();
    await expect(loadProjectIconComponent("Basket")).resolves.toBe(BasketIcon);

    expect(getLoadedProjectIcon("Basket")).toBe(BasketIcon);
    await expect(loadProjectIconComponent("Basket")).resolves.toBe(BasketIcon);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight request between concurrent renders of the same icon", async () => {
    const importer = vi.fn(async () => ({ BasketIcon }));
    setIconImporterForTests(importer);

    const [first, second] = await Promise.all([
      loadProjectIconComponent("Basket"),
      loadProjectIconComponent("Basket"),
    ]);

    expect(first).toBe(BasketIcon);
    expect(second).toBe(BasketIcon);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("retries after a failed chunk load instead of caching the rejection", async () => {
    const importer = vi
      .fn<(moduleName: string) => Promise<Record<string, unknown>>>()
      .mockRejectedValueOnce(new Error("chunk load failed"))
      .mockResolvedValueOnce({ BasketIcon });
    setIconImporterForTests(importer);

    await expect(loadProjectIconComponent("Basket")).resolves.toBeNull();
    expect(getLoadedProjectIcon("Basket")).toBeNull();

    await expect(loadProjectIconComponent("Basket")).resolves.toBe(BasketIcon);
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it("resolves a missing module to null without caching it", async () => {
    const importer = vi.fn(async () => null);
    setIconImporterForTests(importer);

    await expect(loadProjectIconComponent("NotAnIcon")).resolves.toBeNull();
    await expect(loadProjectIconComponent("NotAnIcon")).resolves.toBeNull();
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it("loads a deprecated alias from the module that owns it", async () => {
    const importer = vi.fn(async (moduleName: string) =>
      moduleName === "Folder" ? { FolderIcon: BasketIcon, FolderNotchIcon: BasketIcon } : {},
    );
    setIconImporterForTests(importer);

    await expect(loadProjectIconComponent("FolderNotch")).resolves.toBe(BasketIcon);
    expect(importer).toHaveBeenCalledWith("Folder");
  });

  it("never imports a name that is not a Phosphor icon", async () => {
    const importer = vi.fn(async () => ({}));
    setIconImporterForTests(importer);

    for (const name of ["", "basket", "../secret", "Basket.es", "SparkleSoft"]) {
      await expect(loadProjectIconComponent(name)).resolves.toBeNull();
    }
    expect(importer).not.toHaveBeenCalled();
  });
});
