# Book Details and statistics

Open a book's **Book Details** from its bookshelf menu or the reader.

## Book information

The existing cover, metadata, series and description sections remain the single
place for bibliographic information. Details also exposes subtitle, editor, ISBN,
other identifiers, original filename, total books in series, recorded narration,
episode count and **Date Read**. **Date Added** is labeled consistently with shelf
filters. Audiobook duration is time, never a page count.

**Edit Metadata** edits title, author, cover, subtitle, editor, publisher,
publication date, language, identifiers, subjects, tags, description and series.
Custom library columns (including imported categories) are editable there too:
numbers and dates are validated, flags use Yes/No, and multi-value columns retain
lists rather than being converted into text. Changes use normal metadata sync;
source book files are not rewritten.

## Library and progress

- Set **Unread**, **Reading**, **Finished** or **On hold** directly. This changes
  status without changing the reading position or inventing reading events.
- Edit **Group** using a nested path, such as `Science/Physics`, or clear it.
  Changes use normal group identities and an independent group clock through sync.
  Filesystem-managed libraries can update a group again when the source moves.
- See actual shelf membership, progress, current page/listening position, remaining
  pages/audio, media type, availability and download state.
- Source-derived properties, dates, format, file size and statistics are read-only.
  Audiobookshelf controls its library Date Added. Date Read follows recorded
  reading/listening activity when an explicit reading date is available. Legacy
  ebooks without that field retain upstream’s edit-date fallback; their Date Read
  can reflect import or editing rather than confirmed activity. The first/last
  recorded activity statistics below are derived from actual saved events.

Background cover refreshes merge with the current library after downloads finish,
so edits and books added during a refresh are retained. Pending edits remain
queued until the server acknowledges them, even if its pull cursor has advanced.

## Recorded reading

The existing local statistics database supplies this view. It first shows locally
saved records, then pulls other devices' history when statistics sync is enabled.
The existing shared database connection is reused. Opening details never invents
reading events or publishes reading activity to the server; normal history sync
can populate this device’s database from existing server records. Refresh retries
failed loads.

The overview shows recorded reading time, pages read, visits, repeated visits,
active days, first/last recorded activity, averages per active day/page/visit,
longest visit and reading streaks. A streak day requires at least one minute,
matching the main Readest statistics screen.

**Reading pace** uses the median of up to 50 latest visits that fit within the
current page-event cap, with at least five samples, matching Readest's pace rule.
Pages/hour is derived from that median. Remaining time uses current position and
that pace; it is an estimate, not an additional reading record.

Daily charts and the calendar accompany complete **Daily history**, **Time per
page** and **Activity log** lists. Lists paginate 25 rows at a time without
truncating history. Each page shows accumulated time, number of visits, average
visit time and its first/last recorded activity; the log retains each timestamp,
recorded page total and duration.

Times are displayed in the device timezone. A visit crossing local midnight is
split across calendar days, including daylight-saving changes, without changing
its total duration. Pages with different recorded total-page scales remain
separate. A visit is a statistics record, not proof of an app-open event. Older
imports may have estimated pages/timestamps; this screen does not make those
estimates more precise. Reading and text-to-speech can share the same page
records and cannot be retrospectively separated.

## Audiobookshelf listening

Audiobookshelf details additionally fetches the signed-in account's actual
positive-duration listening sessions, across all history pages. It shows total
recorded listening time, session/day counts, first/last activity, average/longest
session, daily averages/streaks, charts, calendar, and full day/session histories.
This is a read-only API request using the existing custom-server/certificate and
token-refresh support. It does not start playback or write listening sessions.

Daily totals retain Audiobookshelf's session dates. Displayed timestamps use the
device timezone. `timeListening` measures recorded listening (including repeats),
not a playback position or the wall-clock gap between session endpoints. Session
update timestamps approximate activity. Full listening history requires an
available server and unlocked credentials; offline page statistics and book
metadata remain available. Other audiobook providers retain their known progress
and duration but do not have this Audiobookshelf history API.

## Annotations

Counts come from the current open book configuration when available, otherwise
this device's saved configuration: total entries, highlights, underlines,
squiggly underlines, bookmarks, excerpts, notebook/handwriting entries and entries
with written notes. Deleted entries are excluded. Counts do not parse annotations
embedded inside an original PDF unless those were imported into Readest notes.

## Compatibility

No database migration, new server endpoint or dependency is needed. The same
React screen serves web, PWA and native clients; native clients need a rebuilt
application to receive the new screen. Existing progress, bookmarks and statistics
are not rewritten by viewing details.
