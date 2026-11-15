/** Said only while the server reports that the invitation holds a paid seat. */
export function InvitationProLine({ organization, includesSeat }: { organization: string; includesSeat: boolean | undefined }) {
  return includesSeat === true ? <p>{organization} includes Pro with this invitation.</p> : null;
}
