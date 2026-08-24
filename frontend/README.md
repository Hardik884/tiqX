# frontend/ — superseded

This was the standalone organiser/admin dashboard. Everything it did now
lives in `customer-frontend/` under `/organiser/*` and `/admin/*`, so tiqX
deploys as **one** application at one URL rather than two.

Nothing here is built or deployed any more, and it is not part of the Vercel
project. It is kept only as the reference the unified screens were ported
from — its pages map to their replacements like this:

| `frontend/src/pages` | now in `customer-frontend/src/pages` |
| --- | --- |
| `Dashboard.tsx` | `organiser/OrganiserDashboardPage.tsx` |
| `EventsList.tsx` | `organiser/OrganiserEventsPage.tsx` |
| `EventForm.tsx` | `organiser/OrganiserEventFormPage.tsx` |
| `EventDetail.tsx` | `organiser/OrganiserEventDetailPage.tsx` |
| `EventBookings.tsx` | `organiser/OrganiserEventBookingsPage.tsx` |
| `AdminEvents.tsx` | `admin/AdminEventsPage.tsx` |
| `AdminVenues.tsx` | `admin/AdminVenuesPage.tsx` (plus create/detail/seat layout) |
| `Login.tsx` | the shared `LoginPage.tsx` |

Its `lib/api.ts` token handling and `ProtectedRoute` were replaced by the
customer app's existing `api/client.ts` (zustand session, refresh
de-duplication) and `components/RequireRole.tsx`.

Delete this directory once you are satisfied nothing else references it.
