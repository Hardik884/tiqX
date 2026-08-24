import { Navigate, Route, Routes } from 'react-router-dom';

import { ProtectedRoute } from './components/ProtectedRoute';
import { AdminEvents } from './pages/AdminEvents';
import { AdminVenues } from './pages/AdminVenues';
import { Dashboard } from './pages/Dashboard';
import { EventBookings } from './pages/EventBookings';
import { EventDetail } from './pages/EventDetail';
import { EventForm } from './pages/EventForm';
import { EventsList } from './pages/EventsList';
import { Login } from './pages/Login';

export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route
        path="/"
        element={
          <ProtectedRoute roles={['organiser', 'admin']}>
            <Dashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/events"
        element={
          <ProtectedRoute roles={['organiser', 'admin']}>
            <EventsList />
          </ProtectedRoute>
        }
      />
      <Route
        path="/events/new"
        element={
          <ProtectedRoute roles={['organiser', 'admin']}>
            <EventForm />
          </ProtectedRoute>
        }
      />
      <Route
        path="/events/:eventId"
        element={
          <ProtectedRoute roles={['organiser', 'admin']}>
            <EventDetail />
          </ProtectedRoute>
        }
      />
      <Route
        path="/events/:eventId/edit"
        element={
          <ProtectedRoute roles={['organiser', 'admin']}>
            <EventForm />
          </ProtectedRoute>
        }
      />
      <Route
        path="/events/:eventId/bookings"
        element={
          <ProtectedRoute roles={['organiser', 'admin']}>
            <EventBookings />
          </ProtectedRoute>
        }
      />

      <Route
        path="/admin/venues"
        element={
          <ProtectedRoute roles={['admin']}>
            <AdminVenues />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/events"
        element={
          <ProtectedRoute roles={['admin']}>
            <AdminEvents />
          </ProtectedRoute>
        }
      />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
