import React from "react";
import { render, renderHook, screen, within } from "@testing-library/react";
import { KpiCards, useCountUp, type KpiData } from "../KpiCards";

/** useCountUp animates via requestAnimationFrame on real wall-clock time,
 * which is exactly what a user with prefers-reduced-motion: reduce should
 * NOT get — the hook has an explicit branch that sets the value straight to
 * its target for them, skipping the animation entirely. Forcing that branch
 * on is what makes these tests deterministic without racing rAF, and it
 * exercises real, shipped accessibility behaviour rather than a test-only
 * shortcut. */
function mockReducedMotion(matches: boolean) {
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  })) as unknown as typeof window.matchMedia;
}

const baseData: KpiData = {
  raw: 130,
  unique: 105,
  correlated: 90,
  incidents: 4,
  noise: 97,
  totalSeries: [10, 20, 15, 42, 8],
  correlatedSeries: [8, 15, 10, 30, 5],
  incidentSeries: [0, 1, 2, 3, 4],
  peak: 42,
  peakLabel: "16:00",
  p1: 2,
};

beforeEach(() => {
  mockReducedMotion(true);
});

describe("useCountUp", () => {
  it("jumps straight to the target for reduced-motion users, skipping the animation", () => {
    const { result } = renderHook(() => useCountUp(130));
    expect(result.current).toBe("130");
  });

  it("respects the requested decimal precision", () => {
    const { result } = renderHook(() => useCountUp(97.4, 1));
    expect(result.current).toBe("97.4");
  });

  it("formats large integers with thousands separators", () => {
    const { result } = renderHook(() => useCountUp(9695));
    expect(result.current).toBe("9,695");
  });
});

/** Same raw numbers appear on both the top KPI card and the noise-reduction
 * card's own summary (by design — it recaps the same funnel), so value
 * assertions are scoped to the specific card they belong to. */
function cardFor(title: string) {
  // "Raw alerts" also appears as a reduction-step label inside the noise
  // card; the top KPI card always renders first, so its title is match [0].
  return screen.getAllByText(title)[0].closest(".kpi-card") as HTMLElement;
}

describe("KpiCards", () => {
  it("shows each card's own value and correctly derives the removed/correlated percentages", () => {
    render(<KpiCards d={baseData} />);
    expect(within(cardFor("Raw alerts")).getByText("130")).toBeInTheDocument();
    expect(within(cardFor("Unique signals")).getByText("105")).toBeInTheDocument();
    expect(within(cardFor("Correlated signals")).getByText("90")).toBeInTheDocument();
    expect(within(cardFor("Actionable incidents")).getByText("4")).toBeInTheDocument();
    // removedPct = round(100 * (1 - 105/130)) = 19%
    expect(screen.getByText("19%")).toBeInTheDocument();
    // corrPct = round(100 * 90/105) = 86%
    expect(screen.getByText("86%")).toBeInTheDocument();
    expect(screen.getByText("25 duplicates filtered")).toBeInTheDocument(); // 130 - 105
  });

  it("shows the peak chip only when a real peak bucket exists", () => {
    const { rerender } = render(<KpiCards d={baseData} />);
    expect(screen.getByText("42 peak")).toBeInTheDocument();
    expect(screen.getByText("at 16:00")).toBeInTheDocument();

    rerender(<KpiCards d={{ ...baseData, peak: 0, peakLabel: "" }} />);
    expect(screen.queryByText(/peak/)).not.toBeInTheDocument();
  });

  it("shows the P1 count on the actionable-incidents card", () => {
    render(<KpiCards d={baseData} />);
    expect(screen.getByText("2 P1")).toBeInTheDocument();
  });

  it("links each card to the page it summarises", () => {
    render(<KpiCards d={baseData} />);
    expect(screen.getByRole("link", { name: /duplicates filtered/i })).toHaveAttribute("href", "/deduplication");
    expect(screen.getByRole("link", { name: /grouped intelligently/i })).toHaveAttribute("href", "/correlations");
    expect(screen.getByRole("link", { name: /ready for investigation/i })).toHaveAttribute("href", "/incidents");
  });
});

describe("KpiCards — noise reduction card", () => {
  it("grades Excellent at or above 90%, Good in the 70s/80s, Fair below that", () => {
    const { rerender } = render(<KpiCards d={{ ...baseData, noise: 95 }} />);
    expect(screen.getByText("Excellent")).toBeInTheDocument();

    rerender(<KpiCards d={{ ...baseData, noise: 75 }} />);
    expect(screen.getByText("Good")).toBeInTheDocument();

    rerender(<KpiCards d={{ ...baseData, noise: 40 }} />);
    expect(screen.getByText("Fair")).toBeInTheDocument();
  });

  it("shows an honest dash instead of a fabricated percentage when nothing has run yet", () => {
    render(<KpiCards d={{ ...baseData, noise: null }} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("shows the 'N× less noise' line only when the reduction is more than 1x", () => {
    const { rerender } = render(<KpiCards d={{ ...baseData, raw: 130, incidents: 4 }} />); // 33x
    expect(screen.getByText("33× less noise")).toBeInTheDocument();

    rerender(<KpiCards d={{ ...baseData, raw: 4, incidents: 4 }} />); // 1x — nothing to boast about
    expect(screen.queryByText(/× less noise/)).not.toBeInTheDocument();
  });

  it("shows the real reduction-step numbers, labelled as a square-root scale", () => {
    render(<KpiCards d={baseData} />);
    const caption = screen.getByText(/square-root scale/);
    const stepsBlock = caption.parentElement as HTMLElement;
    expect(within(stepsBlock).getByText("130")).toBeInTheDocument(); // raw
    expect(within(stepsBlock).getByText("105")).toBeInTheDocument(); // after dedup
    expect(within(stepsBlock).getByText("90")).toBeInTheDocument(); // in incidents
    expect(within(stepsBlock).getByText("4")).toBeInTheDocument(); // incidents
  });
});
