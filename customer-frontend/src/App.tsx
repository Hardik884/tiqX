import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { RequireAuth } from './components/RequireAuth';
import { RequireRole } from './components/RequireRole';
import { ManageShell } from './components/manage/ManageShell';
import { BookingDetailPage } from './pages/BookingDetailPage';
import { CheckoutPage } from './pages/CheckoutPage';
import { EventDetailPage } from './pages/EventDetailPage';
import { EventsPage } from './pages/EventsPage';
import { LoginPage } from './pages/LoginPage';
import { MyBookingsPage } from './pages/MyBookingsPage';
import { RegisterPage } from './pages/RegisterPage';
import { WaitlistPage } from './pages/WaitlistPage';
import { AdminDashboardPage } from './pages/admin/AdminDashboardPage';
import { AdminEventsPage } from './pages/admin/AdminEventsPage';
import { AdminUsersPage } from './pages/admin/AdminUsersPage';
import { AdminVenueDetailPage } from './pages/admin/AdminVenueDetailPage';
import { AdminVenueFormPage } from './pages/admin/AdminVenueFormPage';
import { AdminVenuesPage } from './pages/admin/AdminVenuesPage';
import { OrganiserDashboardPage } from './pages/organiser/OrganiserDashboardPage';
import { OrganiserEventBookingsPage } from './pages/organiser/OrganiserEventBookingsPage';
import { OrganiserEventDetailPage } from './pages/organiser/OrganiserEventDetailPage';
import { OrganiserEventFormPage } from './pages/organiser/OrganiserEventFormPage';
import { OrganiserEventsPage } from './pages/organiser/OrganiserEventsPage';

/**
 * One route table for the whole product: the customer booking flow, the
 * organiser workspace and the admin workspace, all served by this single Vite
 * app so there is one deployment and one session.
 *
 * The role wrappers here decide what *renders*. They are not the security
 * boundary - every endpoint behind them re-checks the caller's role on the
 * server, and re-reads it from the database rather than trusting the token, so
 * a customer who types /admin into the address bar gets a redirect from this
 * file and a 403 from the API regardless.
 */
function Organiser({ children }: { children: ReactNode }) {
  return (
    <RequireRole roles={['organiser', 'admin']}>
      <ManageShell workspace="organiser">{children}</ManageShell>
    </RequireRole>
  );
}

function Admin({ children }: { children: ReactNode }) {
  return (
    <RequireRole roles={['admin']}>
      <ManageShell workspace="admin">{children}</ManageShell>
    </RequireRole>
  );
}

export default function App() {
  return (
    <Layout>
      <Routes>
        {/* Customer - public discovery */}
        <Route path="/" element={<EventsPage />} />
        <Route path="/events" element={<EventsPage />} />
        <Route path="/events/:eventId" element={<EventDetailPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />

        {/* Customer - signed in */}
        <Route
          path="/checkout"
          element={
            <RequireAuth>
              <CheckoutPage />
            </RequireAuth>
          }
        />
        <Route
          path="/bookings"
          element={
            <RequireAuth>
              <MyBookingsPage />
            </RequireAuth>
          }
        />
        {/* The suggested path for the same screen; /bookings stays canonical so
            existing links and the booking-detail child route keep working. */}
        <Route path="/my-tickets" element={<Navigate to="/bookings" replace />} />
        <Route
          path="/bookings/:bookingId"
          element={
            <RequireAuth>
              <BookingDetailPage />
            </RequireAuth>
          }
        />
        <Route
          path="/waitlist"
          element={
            <RequireAuth>
              <WaitlistPage />
            </RequireAuth>
          }
        />

        {/* Organiser */}
        <Route path="/organiser" element={<Navigate to="/organiser/dashboard" replace />} />
        <Route
          path="/organiser/dashboard"
          element={
            <Organiser>
              <OrganiserDashboardPage />
            </Organiser>
          }
        />
        <Route
          path="/organiser/events"
          element={
            <Organiser>
              <OrganiserEventsPage />
            </Organiser>
          }
        />
        {/* Before /organiser/events/:eventId, so "new" is never read as an id. */}
        <Route
          path="/organiser/events/new"
          element={
            <Organiser>
              <OrganiserEventFormPage />
            </Organiser>
          }
        />
        <Route
          path="/organiser/events/:eventId"
          element={
            <Organiser>
              <OrganiserEventDetailPage />
            </Organiser>
          }
        />
        <Route
          path="/organiser/events/:eventId/edit"
          element={
            <Organiser>
              <OrganiserEventFormPage />
            </Organiser>
          }
        />
        <Route
          path="/organiser/events/:eventId/bookings"
          element={
            <Organiser>
              <OrganiserEventBookingsPage />
            </Organiser>
          }
        />

        {/* Admin */}
        <Route path="/admin" element={<Navigate to="/admin/dashboard" replace />} />
        <Route
          path="/admin/dashboard"
          element={
            <Admin>
              <AdminDashboardPage />
            </Admin>
          }
        />
        <Route
          path="/admin/venues"
          element={
            <Admin>
              <AdminVenuesPage />
            </Admin>
          }
        />
        <Route
          path="/admin/venues/new"
          element={
            <Admin>
              <AdminVenueFormPage />
            </Admin>
          }
        />
        <Route
          path="/admin/venues/:venueId"
          element={
            <Admin>
              <AdminVenueDetailPage />
            </Admin>
          }
        />
        <Route
          path="/admin/events"
          element={
            <Admin>
              <AdminEventsPage />
            </Admin>
          }
        />
        <Route
          path="/admin/users"
          element={
            <Admin>
              <AdminUsersPage />
            </Admin>
          }
        />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
