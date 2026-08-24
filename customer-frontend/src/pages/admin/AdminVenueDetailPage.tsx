import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import {
  addVenueSeats,
  deleteVenueSeat,
  getVenue,
  listVenueSeats,
  setSeatCategory,
  updateVenue,
} from '../../api/venues';
import type { FieldError, SeatCategory, VenueDetail, VenueSeat } from '../../api/types';
import { Button } from '../../components/Button';
import { ErrorState, InlineNote, Spinner } from '../../components/Feedback';
import { Field, FieldRow, SelectInput, TextArea, TextInput } from '../../components/manage/Field';
import { PageHeader } from '../../components/manage/PageHeader';
import { StatCard, StatGrid } from '../../components/manage/StatCard';
import { fieldErrorsOf, fieldMessage, messageOf } from '../../lib/manage';

const CATEGORY_STYLE: Record<SeatCategory, string> = {
  premium: 'bg-brand-50 text-brand-700 ring-brand-200 hover:bg-brand-100',
  standard: 'bg-neutral-100 text-neutral-600 ring-neutral-200 hover:bg-neutral-200',
};

function groupByRow(seats: readonly VenueSeat[]): [string, VenueSeat[]][] {
  const rows = new Map<string, VenueSeat[]>();
  for (const seat of seats) {
    const row = rows.get(seat.rowLabel) ?? [];
    row.push(seat);
    rows.set(seat.rowLabel, row);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, rowSeats]) => [label, [...rowSeats].sort((a, b) => a.seatNumber - b.seatNumber)]);
}

/**
 * A venue's identity and its physical seat layout.
 *
 * The layout is the source every event's seat inventory is derived from - once,
 * at event creation. So changes here shape events created from now on and never
 * reach into an event that already exists; the page says so rather than
 * implying a live edit. Removing a seat any event still sells is refused by the
 * backend (409), which is what keeps a published seat map from quietly losing a
 * row underneath its customers.
 */
export function AdminVenueDetailPage() {
  const { venueId } = useParams<{ venueId: string }>();

  const [venue, setVenue] = useState<VenueDetail | null>(null);
  const [seats, setSeats] = useState<VenueSeat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [description, setDescription] = useState('');
  const [savingDetails, setSavingDetails] = useState(false);
  const [detailsNote, setDetailsNote] = useState<string | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  const [rowLabel, setRowLabel] = useState('');
  const [fromSeat, setFromSeat] = useState('1');
  const [toSeat, setToSeat] = useState('10');
  const [category, setCategory] = useState<SeatCategory>('standard');
  const [addingSeats, setAddingSeats] = useState(false);
  const [seatError, setSeatError] = useState<string | null>(null);
  const [seatFieldErrors, setSeatFieldErrors] = useState<FieldError[]>([]);
  const [seatNote, setSeatNote] = useState<string | null>(null);
  const [busySeatId, setBusySeatId] = useState<string | null>(null);

  async function load() {
    if (venueId === undefined) return;
    setLoading(true);
    setError(null);
    try {
      const [venueData, seatData] = await Promise.all([getVenue(venueId), listVenueSeats(venueId)]);
      setVenue(venueData.venue);
      setSeats(seatData.seats);
      setName(venueData.venue.name);
      setCity(venueData.venue.city ?? '');
      setDescription(venueData.venue.description ?? '');
    } catch (err) {
      setError(messageOf(err, 'Could not load this venue.'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [venueId]);

  async function handleSaveDetails(event: FormEvent) {
    event.preventDefault();
    if (venueId === undefined) return;
    setSavingDetails(true);
    setDetailsError(null);
    setDetailsNote(null);
    try {
      // Empty strings are sent through deliberately: the API reads "" as
      // "clear this column", which is how a city or blurb gets removed.
      const result = await updateVenue(venueId, { name, city, description });
      setVenue(result.venue);
      setDetailsNote('Venue details saved.');
    } catch (err) {
      setDetailsError(messageOf(err, 'Could not save these details.'));
    } finally {
      setSavingDetails(false);
    }
  }

  async function handleAddSeats(event: FormEvent) {
    event.preventDefault();
    if (venueId === undefined) return;
    setAddingSeats(true);
    setSeatError(null);
    setSeatFieldErrors([]);
    setSeatNote(null);
    try {
      const result = await addVenueSeats(venueId, [
        {
          rowLabel: rowLabel.trim().toUpperCase(),
          fromSeat: Number(fromSeat),
          toSeat: Number(toSeat),
          category,
        },
      ]);
      setSeats(result.seats);
      setSeatNote(
        result.created === 0
          ? 'Those seats already exist in this layout — nothing was changed.'
          : `Added ${result.created} seat${result.created === 1 ? '' : 's'}.`,
      );
      setRowLabel('');
      setVenue((await getVenue(venueId)).venue);
    } catch (err) {
      setSeatError(messageOf(err, 'Could not add these seats.'));
      setSeatFieldErrors(fieldErrorsOf(err));
    } finally {
      setAddingSeats(false);
    }
  }

  async function handleToggleCategory(seat: VenueSeat) {
    if (venueId === undefined) return;
    setBusySeatId(seat.id);
    setSeatError(null);
    setSeatNote(null);
    try {
      const next: SeatCategory = seat.category === 'premium' ? 'standard' : 'premium';
      const result = await setSeatCategory(venueId, seat.id, next);
      setSeats(result.seats);
      setVenue((await getVenue(venueId)).venue);
    } catch (err) {
      setSeatError(messageOf(err, 'Could not change this seat’s category.'));
    } finally {
      setBusySeatId(null);
    }
  }

  async function handleDeleteSeat(seat: VenueSeat) {
    if (venueId === undefined) return;
    setBusySeatId(seat.id);
    setSeatError(null);
    setSeatNote(null);
    try {
      const result = await deleteVenueSeat(venueId, seat.id);
      setSeats(result.seats);
      setVenue((await getVenue(venueId)).venue);
      setSeatNote(`Removed ${seat.rowLabel}${seat.seatNumber}.`);
    } catch (err) {
      setSeatError(messageOf(err, 'Could not remove this seat.'));
    } finally {
      setBusySeatId(null);
    }
  }

  if (loading) {
    return <Spinner label="Loading venue…" />;
  }

  if (error !== null || venue === null) {
    return <ErrorState message={error ?? 'Venue not found.'} onRetry={load} />;
  }

  return (
    <>
      <PageHeader
        eyebrow="Admin · Venue"
        title={venue.name}
        description={venue.city ?? undefined}
        backTo="/admin/venues"
        backLabel="Back to venues"
      />

      <StatGrid>
        <StatCard label="Total seats" value={String(venue.seatCount)} tone="accent" />
        <StatCard label="Premium" value={String(venue.seatsByCategory.premium)} />
        <StatCard label="Standard" value={String(venue.seatsByCategory.standard)} />
        <StatCard label="Events here" value={String(venue.eventCount)} hint="already built from this layout" />
      </StatGrid>

      <div className="mt-8 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <form
          onSubmit={handleSaveDetails}
          className="flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5 shadow-card"
        >
          <h2 className="font-display text-base font-bold text-ink-900">Venue details</h2>
          {detailsError && <InlineNote tone="error">{detailsError}</InlineNote>}
          {detailsNote && <InlineNote tone="success">{detailsNote}</InlineNote>}

          <Field label="Name" htmlFor="venue-name">
            <TextInput
              id="venue-name"
              required
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="City" htmlFor="venue-city" hint="Leave empty to clear it.">
            <TextInput
              id="venue-city"
              maxLength={100}
              value={city}
              onChange={(e) => setCity(e.target.value)}
            />
          </Field>
          <Field label="Description" htmlFor="venue-description">
            <TextArea
              id="venue-description"
              maxLength={2000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Button type="submit" loading={savingDetails}>
            Save details
          </Button>
        </form>

        <div className="lg:col-span-2">
          <div className="rounded-lg border border-neutral-200 bg-white p-5 shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-base font-bold text-ink-900">Seat layout</h2>
              <div className="flex items-center gap-3 text-[11px] text-neutral-500">
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-sm bg-brand-500" /> Premium
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-sm bg-neutral-300" /> Standard
                </span>
              </div>
            </div>
            <p className="mt-1.5 text-xs text-neutral-500">
              Click a seat to switch it between premium and standard. Layout changes apply to events created from
              now on — an event’s seat map is built when the event is created.
            </p>

            {seatError && (
              <div className="mt-4">
                <InlineNote tone="error">{seatError}</InlineNote>
              </div>
            )}
            {seatNote && (
              <div className="mt-4">
                <InlineNote tone="success">{seatNote}</InlineNote>
              </div>
            )}

            {seats.length === 0 ? (
              <p className="mt-5 rounded-md border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-500">
                No seats yet. Add a row below — an event cannot be created at a venue with no seats.
              </p>
            ) : (
              <div className="mt-5 flex flex-col gap-2.5">
                {groupByRow(seats).map(([row, rowSeats]) => (
                  <div key={row} className="flex items-start gap-2">
                    <span className="w-6 shrink-0 pt-1.5 text-xs font-semibold text-neutral-400">{row}</span>
                    <div className="flex flex-wrap gap-1.5">
                      {rowSeats.map((seat) => (
                        <span key={seat.id} className="group relative">
                          <button
                            type="button"
                            disabled={busySeatId === seat.id}
                            onClick={() => handleToggleCategory(seat)}
                            title={`${seat.rowLabel}${seat.seatNumber} · ${seat.category} — click to switch`}
                            className={`inline-flex h-8 w-8 items-center justify-center rounded-md text-[11px] font-semibold ring-1 ring-inset transition-colors focus-ring disabled:opacity-40 ${CATEGORY_STYLE[seat.category]}`}
                          >
                            {seat.seatNumber}
                          </button>
                          <button
                            type="button"
                            aria-label={`Remove seat ${seat.rowLabel}${seat.seatNumber}`}
                            disabled={busySeatId === seat.id}
                            onClick={() => handleDeleteSeat(seat)}
                            className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-ink-900 text-[10px] font-bold leading-none text-white group-hover:flex focus-ring"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <form
            onSubmit={handleAddSeats}
            className="mt-5 flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5 shadow-card"
          >
            <h3 className="font-display text-base font-bold text-ink-900">Add a row</h3>
            <FieldRow>
              <Field label="Row label" htmlFor="rowLabel" error={fieldMessage(seatFieldErrors, 'rows.0.rowLabel')}>
                <TextInput
                  id="rowLabel"
                  required
                  maxLength={8}
                  value={rowLabel}
                  error={fieldMessage(seatFieldErrors, 'rows.0.rowLabel')}
                  onChange={(e) => setRowLabel(e.target.value)}
                  placeholder="A"
                />
              </Field>
              <Field label="Category" htmlFor="seatCategory">
                <SelectInput
                  id="seatCategory"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as SeatCategory)}
                >
                  <option value="standard">Standard</option>
                  <option value="premium">Premium</option>
                </SelectInput>
              </Field>
            </FieldRow>
            <FieldRow>
              <Field label="First seat" htmlFor="fromSeat" error={fieldMessage(seatFieldErrors, 'rows.0.fromSeat')}>
                <TextInput
                  id="fromSeat"
                  type="number"
                  min={1}
                  max={1000}
                  required
                  value={fromSeat}
                  error={fieldMessage(seatFieldErrors, 'rows.0.fromSeat')}
                  onChange={(e) => setFromSeat(e.target.value)}
                />
              </Field>
              <Field
                label="Last seat"
                htmlFor="toSeat"
                error={fieldMessage(seatFieldErrors, 'rows.0.toSeat')}
                hint="Up to 100 seats per row."
              >
                <TextInput
                  id="toSeat"
                  type="number"
                  min={1}
                  max={1000}
                  required
                  value={toSeat}
                  error={fieldMessage(seatFieldErrors, 'rows.0.toSeat')}
                  onChange={(e) => setToSeat(e.target.value)}
                />
              </Field>
            </FieldRow>
            <div>
              <Button type="submit" loading={addingSeats}>
                Add seats
              </Button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
