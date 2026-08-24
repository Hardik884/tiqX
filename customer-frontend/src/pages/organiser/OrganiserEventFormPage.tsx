import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { createEvent, getManagedEvent, updateEvent } from '../../api/organiser';
import { listVenues } from '../../api/venues';
import type {
  EventCategory,
  EventType,
  FieldError,
  UpdateEventPayload,
  VenueSummary,
} from '../../api/types';
import { Button } from '../../components/Button';
import { InlineNote, Spinner } from '../../components/Feedback';
import { Field, FieldRow, FormCard, SelectInput, TextArea, TextInput } from '../../components/manage/Field';
import { PageHeader } from '../../components/manage/PageHeader';
import { fieldErrorsOf, fieldMessage, messageOf, toIsoInstant, toLocalInputValue } from '../../lib/manage';
import { categoryLabel } from '../../lib/ui';

const CATEGORIES: EventCategory[] = ['music', 'comedy', 'sports', 'theatre', 'movies', 'other'];
const EVENT_TYPES: { value: EventType; label: string }[] = [
  { value: 'concert', label: 'Concert / live show' },
  { value: 'movie', label: 'Movie screening' },
];

/**
 * Create and edit in one form, because they are the same fields minus the ones
 * the API refuses to change after creation.
 *
 * Venue, event type, pricing and currency are creation-only, and that is the
 * backend's rule rather than a UI choice: an event's seat inventory
 * (`show_seats`, with each seat's price) is derived once, at creation, from the
 * venue's layout - so moving an event to another venue or re-pricing it would
 * leave that inventory describing something that no longer exists. The edit
 * form says so rather than offering fields that would be rejected.
 */
export function OrganiserEventFormPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const isEdit = eventId !== undefined;
  const navigate = useNavigate();

  const [venues, setVenues] = useState<VenueSummary[]>([]);
  /** What the event looked like when the form loaded - see `handleSubmit`. */
  const [initial, setInitial] = useState<UpdateEventPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);

  const [venueId, setVenueId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [eventType, setEventType] = useState<EventType>('concert');
  const [category, setCategory] = useState<EventCategory>('music');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [standardPrice, setStandardPrice] = useState('');
  const [premiumPrice, setPremiumPrice] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [status, setStatus] = useState<'draft' | 'published'>('draft');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [venueList, existing] = await Promise.all([
          listVenues(),
          isEdit ? getManagedEvent(eventId) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setVenues(venueList.venues);
        if (existing !== null) {
          setInitial({
            title: existing.title,
            description: existing.description ?? '',
            category: existing.category,
            startsAt: existing.startsAt,
            endsAt: existing.endsAt,
          });
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
        if (!cancelled) setError(messageOf(err, 'Could not load this form.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [eventId, isEdit]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldErrors([]);
    setSaving(true);

    try {
      if (isEdit) {
        // Only what actually changed. An unchanged `startsAt` still counts as a
        // reschedule to the API, and rescheduling an event that already has
        // bookings or holds is refused (409) - correctly, but sending it
        // anyway would stop an organiser fixing a typo in the title. Times are
        // compared as instants, not as the strings the inputs hold, so
        // re-formatting alone never reads as a change.
        const patch: UpdateEventPayload = {};
        if (initial === null || title !== initial.title) patch.title = title;
        if (initial === null || description !== (initial.description ?? '')) {
          patch.description = description;
        }
        if (initial === null || category !== initial.category) patch.category = category;

        const nextStartsAt = toIsoInstant(startsAt);
        const nextEndsAt = toIsoInstant(endsAt);
        if (
          initial === null ||
          new Date(nextStartsAt).getTime() !== new Date(initial.startsAt ?? '').getTime()
        ) {
          patch.startsAt = nextStartsAt;
        }
        if (
          initial === null ||
          new Date(nextEndsAt).getTime() !== new Date(initial.endsAt ?? '').getTime()
        ) {
          patch.endsAt = nextEndsAt;
        }

        if (Object.keys(patch).length === 0) {
          navigate(`/organiser/events/${eventId}`);
          return;
        }

        await updateEvent(eventId, patch);
        navigate(`/organiser/events/${eventId}`);
        return;
      }

      // The API's pricing record covers every seat category at once, so an
      // empty box means "free", not "unset" - sending a partial record would
      // be rejected. Values stay strings all the way to the NUMERIC column.
      const pricing =
        standardPrice !== '' || premiumPrice !== ''
          ? { standard: standardPrice || '0.00', premium: premiumPrice || '0.00' }
          : undefined;

      const created = await createEvent({
        venueId,
        title,
        description: description.trim() === '' ? undefined : description,
        category,
        eventType,
        startsAt: toIsoInstant(startsAt),
        endsAt: toIsoInstant(endsAt),
        status,
        pricing,
        currency,
      });
      navigate(`/organiser/events/${created.event.id}`);
    } catch (err) {
      setError(messageOf(err, 'Something went wrong while saving this event.'));
      setFieldErrors(fieldErrorsOf(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <Spinner label="Loading form…" />;
  }

  const selectedVenue = venues.find((venue) => venue.id === venueId);

  return (
    <>
      <PageHeader
        eyebrow={isEdit ? 'Edit event' : 'New event'}
        title={isEdit ? title || 'Edit event' : 'Create an event'}
        description={
          isEdit
            ? 'Update the details customers see. Publishing and deletion are actions on the event page.'
            : 'Pick a venue, set the date and price each seat category.'
        }
        backTo={isEdit ? `/organiser/events/${eventId}` : '/organiser/events'}
        backLabel={isEdit ? 'Back to event' : 'Back to my events'}
      />

      <FormCard onSubmit={handleSubmit}>
        {error && <InlineNote tone="error">{error}</InlineNote>}

        {!isEdit && (
          <Field
            label="Venue"
            htmlFor="venueId"
            error={fieldMessage(fieldErrors, 'venueId')}
            hint={
              venues.length === 0
                ? 'No venues are configured yet — an admin needs to add one with a seat layout first.'
                : selectedVenue
                  ? `${selectedVenue.seatCount} seats will be created for this event.`
                  : 'Seat inventory is created from the venue’s layout when the event is created.'
            }
          >
            <SelectInput
              id="venueId"
              required
              value={venueId}
              error={fieldMessage(fieldErrors, 'venueId')}
              onChange={(e) => setVenueId(e.target.value)}
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
            </SelectInput>
          </Field>
        )}

        <Field label="Title" htmlFor="title" error={fieldMessage(fieldErrors, 'title')}>
          <TextInput
            id="title"
            required
            maxLength={200}
            value={title}
            error={fieldMessage(fieldErrors, 'title')}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Neon Nights Live"
          />
        </Field>

        <Field label="Description" htmlFor="description" hint="Shown to customers on the event page.">
          <TextArea
            id="description"
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What should people know before they book?"
          />
        </Field>

        <FieldRow>
          {!isEdit && (
            <Field label="Type" htmlFor="eventType" hint="Cannot be changed later.">
              <SelectInput
                id="eventType"
                value={eventType}
                onChange={(e) => setEventType(e.target.value as EventType)}
              >
                {EVENT_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </SelectInput>
            </Field>
          )}
          <Field label="Category" htmlFor="category" hint="How customers browse for it.">
            <SelectInput
              id="category"
              value={category}
              onChange={(e) => setCategory(e.target.value as EventCategory)}
            >
              {CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {categoryLabel(value)}
                </option>
              ))}
            </SelectInput>
          </Field>
        </FieldRow>

        <FieldRow>
          <Field label="Starts at" htmlFor="startsAt" error={fieldMessage(fieldErrors, 'startsAt')}>
            <TextInput
              id="startsAt"
              type="datetime-local"
              required
              value={startsAt}
              error={fieldMessage(fieldErrors, 'startsAt')}
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </Field>
          <Field label="Ends at" htmlFor="endsAt" error={fieldMessage(fieldErrors, 'endsAt')}>
            <TextInput
              id="endsAt"
              type="datetime-local"
              required
              value={endsAt}
              error={fieldMessage(fieldErrors, 'endsAt')}
              onChange={(e) => setEndsAt(e.target.value)}
            />
          </Field>
        </FieldRow>

        {!isEdit ? (
          <>
            <div className="rounded-md border border-neutral-200 bg-neutral-50 p-4">
              <h3 className="text-sm font-semibold text-ink-900">Seat pricing</h3>
              <p className="mt-1 text-xs text-neutral-500">
                Each seat is priced by its category in the venue’s layout. Prices are fixed for the life of the
                event.
              </p>
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Field label="Standard" htmlFor="standardPrice" error={fieldMessage(fieldErrors, 'pricing.standard')}>
                  <TextInput
                    id="standardPrice"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={standardPrice}
                    error={fieldMessage(fieldErrors, 'pricing.standard')}
                    onChange={(e) => setStandardPrice(e.target.value)}
                  />
                </Field>
                <Field label="Premium" htmlFor="premiumPrice" error={fieldMessage(fieldErrors, 'pricing.premium')}>
                  <TextInput
                    id="premiumPrice"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={premiumPrice}
                    error={fieldMessage(fieldErrors, 'pricing.premium')}
                    onChange={(e) => setPremiumPrice(e.target.value)}
                  />
                </Field>
                <Field label="Currency" htmlFor="currency" error={fieldMessage(fieldErrors, 'currency')}>
                  <TextInput
                    id="currency"
                    maxLength={3}
                    value={currency}
                    error={fieldMessage(fieldErrors, 'currency')}
                    onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                  />
                </Field>
              </div>
            </div>

            <Field
              label="Visibility"
              htmlFor="status"
              hint="A draft stays private until you publish it. Published events cannot be deleted."
            >
              <SelectInput
                id="status"
                value={status}
                onChange={(e) => setStatus(e.target.value as 'draft' | 'published')}
              >
                <option value="draft">Save as draft</option>
                <option value="published">Publish immediately</option>
              </SelectInput>
            </Field>
          </>
        ) : (
          <InlineNote tone="neutral">
            Venue, event type and seat pricing are fixed once an event exists — its seat inventory was already
            created from them.
          </InlineNote>
        )}

        <div className="mt-2 flex gap-2">
          <Button type="submit" loading={saving} size="lg">
            {isEdit ? 'Save changes' : 'Create event'}
          </Button>
          <Button type="button" variant="secondary" size="lg" onClick={() => navigate(-1)} disabled={saving}>
            Cancel
          </Button>
        </div>
      </FormCard>
    </>
  );
}
