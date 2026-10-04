---
title: Media Management
description: Find releases and review downloaded files in Foreseerr.
sidebar_position: 6
---

# Media Management

Open **Manage Movie** or **Manage Series** from a title’s detail page. The
section shortcuts keep requests, downloads, media links, and advanced tools
within reach. Available sections depend on your permissions and the title’s
Radarr or Sonarr mapping.

On **Requests**, content type, status, sorting, and page size have labeled
controls and remain in the URL so Back and shared links preserve your view.
Choose **Manage** to open a title’s management panel. **Actions** contains
request deletion and, when available, removal from the mapped service.
Request deletion keeps downloaded files; service removal affects the whole
movie or series and its files. Each action has its own confirmation.

Inside a title’s request record, **Requested content** explains Watch Ahead
and expands the exact requested episodes. Requester and last-editor details
are labeled separately.

Request dialogs keep **Request** and **Cancel** visible while you scroll.
Collection requests show how many movies you selected and provide **Clear
selection**. Each movie has a labeled checkbox; movies already requested,
available, or blocklisted cannot be selected. When your quota cannot cover the
whole collection, choose individual movies. Expand the remaining-request count
to review your limits or open your profile.

While a request is being submitted, its action shows **Requesting…**. If it
fails, your selections remain available for retry.

## Find releases

Choose **Find releases** in the mapped service panel. For a series, choose an
episode or a season pack before searching; the episode picker accepts names
and numbers. A season pack may include episodes you already have.

Filter the returned releases by title, quality, indexer, or protocol. Sort by
age, file size, or seeders, or keep the service’s default order. **Ready to
download only** hides releases with warnings or unavailable download actions.
**Show more releases** reveals additional results.

Each result shows its quality, size, age, indexer, and available seeder count.
Review the reasons on a **Needs review** result before choosing **Download
anyway**. Downloading sends the release to the mapped service and its download
client.

## Import files

**Import files** stays visible even when no download needs attention. Use
**Check downloads again** to refresh its status. A count on the workflow button
shows completed downloads available for review.

Choose a source and **Review Files**, then select the files to import.
Incomplete files stay disabled until the service has enough metadata. For
series, episode assignments can be corrected and applied through Sonarr.

**Move Files** removes the source files from the download folder after adding
them to the library. **Copy Files** keeps the originals. Review the confirmation
and any warnings before importing. **Cancel** or **Escape** dismisses the
confirmation while preserving your selections.

Switching between release search and file import preserves the current review
while the panel stays open. Interventions can also open the import workflow
directly for a download requiring attention.
