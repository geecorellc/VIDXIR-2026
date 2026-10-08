/**
 * Dashboard information architecture (§44).
 *
 * The prototype's seven tabs become seven routes. The order, labels and icons are
 * preserved exactly; only the mechanism changes from a `tab` state variable to
 * real URLs, so a stage is linkable, refreshable and back-button-safe.
 */

export interface NavItem {
  /** Route segment under /dashboard. Empty string = the overview index. */
  segment: string;
  href: string;
  label: string;
  /** lucide icon name, resolved by the component. */
  icon: string;
  /**
   * When set, this stage needs a project that has reached the given point;
   * the sidebar shows a muted dot the way the prototype did for locked tabs.
   */
  requires?: "idea" | "script" | "video";
  /**
   * This stage works without a connected YouTube channel (Phase 11 §2, §4; §1C).
   *
   * Every other content stage is gated on a channel, because it is the channel
   * that gives research its niche and publishing its destination. The two seeded
   * entries are the exceptions: paste a URL, or describe an idea, and research it
   * with no channel at all. Declared here rather than as a segment check in the
   * sidebar so the fact lives with the route it describes.
   */
  channelless?: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { segment: "", href: "/dashboard", label: "Overview", icon: "LayoutDashboard" },
  {
    /**
     * Placed directly above Research because it is the same step by a different
     * door: research seeded by a pasted link rather than by a connected channel.
     */
    segment: "youtube",
    href: "/dashboard/youtube",
    label: "Create from YouTube",
    icon: "Youtube",
    channelless: true,
  },
  {
    /**
     * The third door (§1C): research seeded by the user's own written idea.
     *
     * Beside the link entry rather than under Research, because the three are
     * alternatives at the same point in the workflow — pick your seed, then the rest
     * of the sequence is identical.
     */
    segment: "describe",
    href: "/dashboard/describe",
    label: "Describe an idea",
    icon: "PenLine",
    channelless: true,
  },
  { segment: "research", href: "/dashboard/research", label: "Research", icon: "Search" },
  {
    segment: "script",
    href: "/dashboard/script",
    label: "Script",
    icon: "FileText",
    requires: "idea",
  },
  {
    segment: "video",
    href: "/dashboard/video",
    label: "Video",
    icon: "Clapperboard",
    requires: "script",
  },
  {
    segment: "thumbnail",
    href: "/dashboard/thumbnail",
    label: "Thumbnail",
    icon: "ImageIcon",
    requires: "script",
  },
  {
    segment: "publish",
    href: "/dashboard/publish",
    label: "Publish",
    icon: "Send",
    requires: "video",
  },
  { segment: "channels", href: "/dashboard/channels", label: "Channels", icon: "Radio" },
] as const;

/**
 * Secondary nav shown beneath the divider.
 *
 * Analytics lives here rather than becoming an eighth primary tab: the
 * prototype's seven stages are a *workflow*, in order, and inserting a reporting
 * view into that sequence would misrepresent it. Reporting is something you
 * consult, like billing — not a step you pass through.
 */
export const SECONDARY_NAV: readonly NavItem[] = [
  {
    segment: "analytics",
    href: "/dashboard/analytics",
    label: "Analytics",
    icon: "BarChart3",
  },
  { segment: "settings", href: "/dashboard/settings", label: "Settings", icon: "Settings" },
  { segment: "support", href: "/dashboard/support", label: "Support", icon: "LifeBuoy" },
  { segment: "billing", href: "/dashboard/billing", label: "Plan & billing", icon: "CreditCard" },
] as const;
