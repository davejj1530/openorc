import type { OrganizationProjectAdded, SpaceProject } from "@openorc/protocol";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Keyboard, TextInput, View } from "react-native";
import { SheetPill } from "../changes/SheetParts";
import { queryClient, useRpc, useRpcMutation } from "../client";
import { Check, Search } from "../generated/icons";
import { cn } from "../ui/cn";
import { haptic } from "../ui/haptics";
import { ListPressable } from "../ui/ListPressable";
import { PinnedSheet } from "../ui/PinnedSheet";
import { SheetHeader } from "../ui/SheetHeader";
import { WorkingMark } from "../ui/StateMark";
import { Text } from "../ui/Text";
import { addedChoice, addLabel, repositoryKey, repositoryRows, type Repository, type RepositoryRow } from "./add-projects";

function closeSheet() {
  Keyboard.dismiss();
  router.back();
}

/** One repository: its name over its full name, ticked while chosen, and said to be added once it is a project. */
function Row({ row, held, onPress }: { row: RepositoryRow; held: boolean; onPress: () => void }) {
  const added = row.state === "added";
  return (
    <View>
      <ListPressable
        accessibilityRole="checkbox"
        accessibilityLabel={added ? `${row.repository.fullName}, added` : row.repository.fullName}
        accessibilityState={{ checked: row.state !== "open", disabled: added || held }}
        disabled={added || held}
        onPress={onPress}
        className={cn("mx-2 min-h-touch-row flex-row items-center gap-3 rounded-md px-3 active:bg-surface-2", row.state === "chosen" && "bg-surface")}
      >
        <View className={cn("min-w-0 flex-1 py-2", added && "opacity-40")}>
          <Text numberOfLines={1} className="text-md">
            {row.name}
          </Text>
          <Text numberOfLines={1} className="text-sm text-ink-4">
            {row.repository.fullName}
          </Text>
        </View>
        {added ? <Text className="text-sm text-ink-4">Added</Text> : null}
        {row.state === "chosen" ? <Check size={16} /> : null}
      </ListPressable>
      {row.error ? (
        <Text accessibilityRole="alert" className="px-5 pb-2 text-sm text-bad">
          {row.error}
        </Text>
      ) : null}
    </View>
  );
}

/** One plain sentence where the list would be. */
const Said = ({ children }: { children: string }) => <Text className="px-10 py-10 text-center text-md text-ink-3">{children}</Text>;

/** The search field over the list. */
function FindField({ query, onQuery }: { query: string; onQuery: (query: string) => void }) {
  return (
    <View className="mx-5 mb-2 h-touch flex-row items-center gap-2 rounded-lg bg-surface px-3">
      <Search size={16} className="text-ink-4" />
      <TextInput
        value={query}
        onChangeText={onQuery}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        placeholder="Find a repository"
        placeholderTextColorClassName="accent-ink-4"
        accessibilityLabel="Find a repository"
        className="min-w-0 flex-1 p-0 font-sans text-md text-ink"
      />
    </View>
  );
}

/** What stands where the list would be while there is none: the read on its way, why it failed, or where GitHub is connected. */
function Unlisted({ loaded, error }: { loaded: boolean; error: string | null }) {
  if (loaded) return <Said>Connect GitHub in OpenOrc on your Mac to add its repositories here.</Said>;
  if (error) return <Said>{error}</Said>;
  return (
    <View className="items-center py-10">
      <WorkingMark size={20} />
    </View>
  );
}

/**
 * Adds repositories as the space's projects, then opens New thread on the first: Home lists a project once it holds a
 * thread. A call that failed keeps its words (`error`) and what was ticked; `outcomes` says how each repository went.
 */
function useAdding(spaceId: string) {
  const add = useRpcMutation("organization.projects.add");
  const [outcomes, setOutcomes] = useState<readonly OrganizationProjectAdded[]>([]);
  const submit = async (picked: readonly RepositoryRow[]) => {
    if (!picked.length || add.isPending) return;
    const result = await add.mutateAsync({ spaceId, repositories: picked.map(({ repository }) => ({ installationId: repository.installationId, repoId: repository.repoId })) }).catch(() => null);
    if (!result) return haptic.fail();
    setOutcomes((before) => [...before.filter((each) => !result.some((next) => repositoryKey(next) === repositoryKey(each))), ...result]);
    if (!result.every((each) => each.state === "added")) return haptic.fail();
    haptic.confirm();
    await queryClient.invalidateQueries({ queryKey: ["spaces.projects"] });
    const projectId = addedChoice(queryClient.getQueryData<SpaceProject[]>(["spaces.projects", { spaceId }]), result);
    if (!projectId) return closeSheet();
    Keyboard.dismiss();
    router.dismissTo("/");
    router.push({ pathname: "/new", params: { projectId } });
  };
  return { outcomes, pending: add.isPending, error: add.error?.message ?? null, submit };
}

/** The connected space's repositories under their search, with the button that adds the ticked ones. */
function Repositories({ spaceId, repositories }: { spaceId: string; repositories: readonly Repository[] }) {
  const adding = useAdding(spaceId);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const rows = repositoryRows(repositories, query, chosen, adding.outcomes);
  const picked = repositoryRows(repositories, "", chosen, adding.outcomes).filter((row) => row.state === "chosen");
  const toggle = (key: string) => {
    haptic.select();
    setChosen((before) => (before.includes(key) ? before.filter((each) => each !== key) : [...before, key]));
  };
  return (
    <PinnedSheet
      onAccessibilityEscape={closeSheet}
      top={
        <>
          <SheetHeader title={TITLE} onClose={closeSheet} locked={adding.pending} />
          <FindField query={query} onQuery={setQuery} />
        </>
      }
      footer={
        <>
          {adding.error ? (
            <Text accessibilityRole="alert" className="px-1 text-sm text-bad">
              {adding.error}
            </Text>
          ) : null}
          <SheetPill label={adding.pending ? "Adding…" : addLabel(picked.length)} dim={!picked.length} running={adding.pending} onPress={() => void adding.submit(picked)} />
        </>
      }
    >
      {rows.map((row) => (
        <Row key={row.key} row={row} held={adding.pending} onPress={() => toggle(row.key)} />
      ))}
      {rows.length ? null : <Said>{query.trim() ? "No repositories found" : "No repositories available"}</Said>}
    </PinnedSheet>
  );
}

const TITLE = "Add projects";

/**
 * A space's GitHub repositories to add as its projects, as the Mac's Add projects offers them: search, tick, add. The
 * phone's own session of OpenOrc Cloud reads and adds them, so it works with the Mac asleep. Once added, New thread
 * opens on the first of them. Connecting GitHub takes the Mac's browser, so with none connected the sheet says where
 * to do that.
 */
export function AddProjectsSheet() {
  const { spaceId } = useLocalSearchParams<{ spaceId: string }>();
  const read = useRpc("organization.repositories", { spaceId }, { staleTime: 0 });
  if (read.data?.installations.length) return <Repositories spaceId={spaceId} repositories={read.data.repositories} />;
  const failed = !read.data && read.isError;
  return (
    <PinnedSheet
      onAccessibilityEscape={closeSheet}
      top={<SheetHeader title={TITLE} onClose={closeSheet} />}
      footer={failed ? <SheetPill label="Try again" dim={false} running={read.isFetching} onPress={() => void read.refetch()} /> : null}
    >
      <Unlisted loaded={Boolean(read.data)} error={failed ? read.error.message : null} />
    </PinnedSheet>
  );
}
