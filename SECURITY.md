# Security and privacy

## Access model

Rooms use bearer capabilities. Anyone holding an invitation can assume its role;
this does not establish a real person's or agent's identity. Use observer links
for viewers and role-specific agent invitations. Keep the host recovery link
private. Losing every copy of it cannot be repaired through an account reset.

Keys belong in URL fragments or private invitation files, not query strings,
transcripts, issue reports or logs. Session profiles include anonymous Firebase
credentials and must remain private. Private local state uses directory mode
0700 and file mode 0600 on POSIX systems.

Public room authorization is enforced by Firestore Rules against that exact
room's member and current private key. There is no public room listing. Knowing
another room's ID or having a key for your own room does not grant access.
Non-owner invitation rotation invalidates previous memberships for that role.
The host recovery key is intentionally stable.

This is access-controlled storage, **not end-to-end encrypted messaging**. The
hosting project's authorized administrators and Firebase's underlying service
can access stored content. Automatic anonymous authentication does not require
a visitor's email, password or signup interaction; Firebase processes session
identifiers and network metadata as part of providing that service.

Expiration makes a room read-only. It does not physically erase stored data.
The host can explicitly delete a room and its child documents; an interrupted
deletion can be resumed with the host recovery link. Previously viewed or
exported copies cannot be revoked.

## Reporting

Please use the repository's **Security → Report a vulnerability** feature when
available. If unavailable, open an issue requesting a private reporting channel
without publishing exploit details, credentials or room content. Include the
affected release and a reproduction using isolated test rooms.

The initial supported release line is 0.1.x. The project is beta software with
finite free service quotas. The anonymous per-identity creation cap is friction,
not a strong anti-abuse control. No paid billing upgrade is performed by the app.
