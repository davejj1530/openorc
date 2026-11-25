import { citationLinks } from "@openorc/client";
import { memo, useCallback, useContext, useEffect, useMemo } from "react";
import { Linking, StyleSheet } from "react-native";
import { EnrichedMarkdownText, type LinkPressEvent } from "react-native-enriched-markdown";
import remend from "remend";
import { fonts } from "../generated/tokens";
import { haptic } from "../ui/haptics";
import { openInApp } from "../ui/web";
import { useColors, useMode } from "../ui/mode";
import { COMMIT_LINKS, commitAt, withCommitLinks } from "./commit-links";
import { markdownStyle, type MarkdownTone } from "./markdown-style";
import { countMount } from "./perf-probe";
import { NO_PROOFS, PROOF_LINKS, proofAt, withProofs, type ReplyProof } from "./reply-proof";
import { QuoteContext } from "./quoting";
import { CommitScopeContext, openCommit, useNamedCommits } from "./use-commit-links";

/**
 * A link the phone can follow: a web page in Safari over the thread, mail in Mail. Files on the Mac read as
 * references; the phone has no file panel to open them in. A commit's id opens the commit, where the thread holds it.
 */
function openLink(url: string) {
  if (/^https?:/i.test(url)) openInApp(url);
  else if (/^mailto:/i.test(url)) void Linking.openURL(url);
}

/** The proofs a reply's lines carry, and what pressing one opens. */
export interface MarkdownProofs {
  list: ReplyProof[];
  open: (proof: ReplyProof) => void;
}

/** Quote on selected words: the passage goes to the composer, with the light tap a copy gives. */
function quoted(quote: (text: string) => void, passage: string) {
  if (!passage.trim()) return;
  haptic.tap();
  quote(passage.trim());
}

/** A copied code block confirms itself with the light tap the desktop shows as a check. */
const copied = haptic.tap;

const streamingConfig = { tableMode: "progressive", codeBlockMode: "progressive" } as const;
const remendOptions = { linkMode: "text-only" } as const;

/**
 * A reply as native Markdown, or a muted note in the reply's recipe. While it streams, the unfinished tail is closed
 * off (an open fence, a half link) so it renders as it will once complete, and new words fade in on the desktop's
 * schedule.
 */
export const Markdown = memo(function Markdown({ text, streaming, tone = "reply", proofs }: { text: string; streaming: boolean; tone?: MarkdownTone; proofs?: MarkdownProofs }) {
  const mode = useMode();
  const palette = useColors();
  useEffect(() => countMount("markdown"), []);
  const style = useMemo(() => {
    const base = markdownStyle(palette, mode, StyleSheet.hairlineWidth, tone);
    return {
      ...base,
      linkVariants: {
        // A proof reads as a quiet pill, as the desktop's: its words in green where it holds, all in red where it failed.
        [PROOF_LINKS.ok]: { color: palette.ok, underline: false, backgroundColor: palette["content-soft"] },
        [PROOF_LINKS.bad]: { color: palette.bad, underline: false, backgroundColor: palette["bad-soft"] },
        [PROOF_LINKS.none]: { color: palette["ink-3"], underline: false, backgroundColor: palette["content-soft"] },
        // A commit's id keeps the code's face and ground, underlined as the way to the commit.
        [COMMIT_LINKS]: { fontFamily: fonts.mono, color: palette["content-ink"], underline: true },
        // A file the agent cites reads as code, not as a link to follow.
        "^(?!https?:|mailto:|proof:|commit:)": { color: palette["content-ink"], underline: false, backgroundColor: palette["content-soft"] },
      },
    };
  }, [palette, mode, tone]);
  const list = proofs?.list;
  const commits = useContext(CommitScopeContext);
  const named = useNamedCommits(text, streaming);
  const markdown = useMemo(() => {
    const linked = withProofs(withCommitLinks(citationLinks(text), named), list ?? NO_PROOFS);
    return streaming ? remend(linked, remendOptions) : linked;
  }, [text, streaming, list, named]);
  const onLinkPress = useCallback(
    ({ url }: LinkPressEvent) => {
      const proof = proofs ? proofAt(url, proofs.list) : null;
      const commit = commits ? commitAt(url) : null;
      if (proof) proofs!.open(proof);
      else if (commit) openCommit(commits!, commit);
      else openLink(url);
    },
    [proofs, commits],
  );
  const quote = useContext(QuoteContext);
  // Selected words offer Quote beside Copy, where the thread has a composer to take the passage.
  const menu = useMemo(() => (quote ? [{ text: "Quote", icon: "text.quote", onPress: ({ text: passage }: { text: string }) => quoted(quote, passage) }] : undefined), [quote]);
  return (
    <EnrichedMarkdownText
      flavor="github"
      markdown={markdown}
      markdownStyle={style}
      streamingAnimation={streaming}
      streamingConfig={streamingConfig}
      selectable
      contextMenuItems={menu}
      allowTrailingMargin={false}
      onLinkPress={onLinkPress}
      onCopyPress={copied}
    />
  );
});
