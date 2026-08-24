import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { api, ApiError } from '../lib/api';
import type { EventCategory, EventType, EventView, FieldError, Venue } from '../lib/types';

const EVENT_TYPES: EventType[] = ['movie', 'concert'];
const CATEGORIES: EventCategory[] = ['music', 'comedy', 'sports', 'theatre', 'movies', 'other'];

function toLocalInputValue(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fieldMessage(fieldErrors: FieldError[] | undefined, field: string): string | undefined {
  return fieldErrors?.find((entry) => entry.field === field)?.message;
}

export function EventForm(): JSX.Element {
  const { eventId } = useParams<{ eventId: string }>();
  const isEdit = eventId !== undefined;
  const navigate = useNavigate();

  const [venues, setVenues] = useState<Venue[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldError[] | undefined>(undefined);

  const [venueId, setVenueId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [eventType, setEventType] = useState<EventType>('concert');
  const [category, setCategory] = useState<EventCategory>('other');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [standardPrice, setStandardPrice] = useState('');
  const [premiumPrice, setPremiumPrice] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [asDraft, setAsDraft] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      setLoading(true);
      setError(null);
      try {
        const [venueList, existing] = await Promise.all([
          api.get<{ venues: Venue[] }>('/venues'),
          isEdit ? api.get<EventView>(`/events/${eventId}`) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setVenues(venueList.venues);
        if (existing) {
          setVenueId(existing.venue.id);
          setTitle(existing.title);
          setDescription(existing.description ?? '');
          setEventType(existing.eventType);
          setCategory(existing.category);
          setStartsAt(toLocalInputValue(existing.startsAt));
          setEndsAt(toLocalInputValue(existing.endsAt));
          setCurrency(existing.currency);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load this form.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [eventId, isEdit]);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setFieldErrors(undefined);
    setSaving(true);

    try {
      if (isEdit) {
        await api.patch(`/events/${eventId}`, {
          title,
          description: description || undefined,
          category,
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
        });
        navigate(`/events/${eventId}`);
      } else {
        // The backend's pricing schema is an exact record over every seat
        // category (standard + premium), not a partial one - see
        // event.schema.ts::createEventSchema. Omitting it entirely prices
        // every seat at 0; supplying it at all means supplying both keys, so
        // an empty field is sent as "0.00" rather than dropped.
        const pricing =
          standardPrice || premiumPrice
            ? { standard: standardPrice || '0.00', premium: premiumPrice || '0.00' }
            : undefined;

        const created = await api.post<{ event: EventView }>('/events', {
          venueId,
          title,
          description: description || undefined,
          category,
          eventType,
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
          status: asDraft ? 'draft' : 'published',
          pricing,
          currency,
        });
        navigate(`/events/${created.event.id}`);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else {
        setError('Something went wrong while saving this event.');
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <Loading label="Loading form…" />;
  }

  return (
    <div>
      <div className="main-header">
        <div className="main-header-text">
          <span className="main-header-eyebrow">{isEdit ? 'Edit event' : 'New event'}</span>
          <h1>{isEdit ? title || 'Edit event' : 'Create an event'}</h1>
        </div>
      </div>

      {error ? <ErrorBanner message={error} /> : null}

      <form className="card card-pad form-grid" onSubmit={handleSubmit} style={{ maxWidth: 720 }}>
        {!isEdit ? (
          <div className="field">
            <label htmlFor="venue">Venue</label>
            <select
              id="venue"
              className="input"
              value={venueId}
              onChange={(event) => setVenueId(event.target.value)}
              required
            >
              <option value="" disabled>
                Select a venue
              </option>
              {venues.map((venue) => (
                <option key={venue.id} value={venue.id} disabled={venue.seatCount === 0}>
                  {venue.name}
                  {venue.city ? ` · ${venue.city}` : ''} ({venue.seatCount} seats)
                </option>
              ))}
            </select>
            {venues.length === 0 ? (
              <span className="field-hint">No venues are configured yet - ask an admin to add one.</span>
            ) : null}
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="title">Title</label>
          <input
            id="title"
            className={`input${fieldMessage(fieldErrors, 'title') ? ' has-error' : ''}`}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
          />
          {fieldMessage(fieldErrors, 'title') ? <span className="field-error">{fieldMessage(fieldErrors, 'title')}</span> : null}
        </div>

        <div className="field">
          <label htmlFor="description">Description</label>
          <textarea
            id="description"
            className="input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        <div className="form-row">
          {!isEdit ? (
            <div className="field">
              <label htmlFor="eventType">Type</label>
              <select
                id="eventType"
                className="input"
                value={eventType}
                onChange={(event) => setEventType(event.target.value as EventType)}
              >
                {EVENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="field">
            <label htmlFor="category">Category</label>
            <select
              id="category"
              className="input"
              value={category}
              onChange={(event) => setCategory(event.target.value as EventCategory)}
            >
              {CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="startsAt">Starts at</label>
            <input
              id="startsAt"
              type="datetime-local"
              className={`input${fieldMessage(fieldErrors, 'startsAt') ? ' has-error' : ''}`}
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="endsAt">Ends at</label>
            <input
              id="endsAt"
              type="datetime-local"
              className={`input${fieldMessage(fieldErrors, 'endsAt') ? ' has-error' : ''}`}
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
              required
            />
            {fieldMessage(fieldErrors, 'endsAt') ? (
              <span className="field-error">{fieldMessage(fieldErrors, 'endsAt')}</span>
            ) : null}
          </div>
        </div>

        {!isEdit ? (
          <>
            <div className="form-row">
              <div className="field">
                <label htmlFor="standardPrice">Standard seat price</label>
                <input
                  id="standardPrice"
                  className="input"
                  placeholder="0.00"
                  value={standardPrice}
                  onChange={(event) => setStandardPrice(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="premiumPrice">Premium seat price</label>
                <input
                  id="premiumPrice"
                  className="input"
                  placeholder="0.00"
                  value={premiumPrice}
                  onChange={(event) => setPremiumPrice(event.target.value)}
                />
              </div>
            </div>

            <div className="form-row">
              <div className="field">
                <label htmlFor="currency">Currency</label>
                <input
                  id="currency"
                  className="input"
                  value={currency}
                  maxLength={3}
                  onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                />
              </div>
              <div className="field">
                <label htmlFor="asDraft">Status</label>
                <select
                  id="asDraft"
                  className="input"
                  value={asDraft ? 'draft' : 'published'}
                  onChange={(event) => setAsDraft(event.target.value === 'draft')}
                >
                  <option value="draft">Draft (not visible to customers)</option>
                  <option value="published">Published</option>
                </select>
              </div>
            </div>
          </>
        ) : (
          <p className="field-hint">
            Venue, type and status cannot be changed here. Publishing and cancellation are separate actions on the
            event page.
          </p>
        )}

        <div className="flex gap-3">
          <button type="submit" className="btn" disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create event'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => navigate(-1)} disabled={saving}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
