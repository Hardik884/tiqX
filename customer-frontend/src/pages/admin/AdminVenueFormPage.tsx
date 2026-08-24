import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { createVenue } from '../../api/venues';
import type { FieldError } from '../../api/types';
import { Button } from '../../components/Button';
import { InlineNote } from '../../components/Feedback';
import { Field, FormCard, TextArea, TextInput } from '../../components/manage/Field';
import { PageHeader } from '../../components/manage/PageHeader';
import { fieldErrorsOf, fieldMessage, messageOf } from '../../lib/manage';

/**
 * Creating a venue is deliberately just its identity - name, city, blurb. The
 * seat layout is laid out afterwards on the venue's own page, because a layout
 * is built row by row and is the part an admin comes back to.
 */
export function AdminVenueFormPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldErrors([]);
    setSaving(true);
    try {
      const created = await createVenue({
        name,
        city: city.trim() === '' ? undefined : city,
        description: description.trim() === '' ? undefined : description,
      });
      navigate(`/admin/venues/${created.venue.id}`);
    } catch (err) {
      setError(messageOf(err, 'Could not create this venue.'));
      setFieldErrors(fieldErrorsOf(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="New venue"
        description="Add the venue first, then lay out its seats."
        backTo="/admin/venues"
        backLabel="Back to venues"
      />

      <FormCard onSubmit={handleSubmit}>
        {error && <InlineNote tone="error">{error}</InlineNote>}

        <Field label="Name" htmlFor="name" error={fieldMessage(fieldErrors, 'name')}>
          <TextInput
            id="name"
            required
            maxLength={200}
            value={name}
            error={fieldMessage(fieldErrors, 'name')}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Aurora Arena"
          />
        </Field>

        <Field
          label="City"
          htmlFor="city"
          hint="Customers filter events by city — a venue without one never matches that filter."
          error={fieldMessage(fieldErrors, 'city')}
        >
          <TextInput
            id="city"
            maxLength={100}
            value={city}
            error={fieldMessage(fieldErrors, 'city')}
            onChange={(e) => setCity(e.target.value)}
            placeholder="e.g. Mumbai"
          />
        </Field>

        <Field label="Description" htmlFor="description">
          <TextArea
            id="description"
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Anything worth knowing about this venue."
          />
        </Field>

        <div className="mt-2 flex gap-2">
          <Button type="submit" size="lg" loading={saving}>
            Create venue
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            onClick={() => navigate('/admin/venues')}
            disabled={saving}
          >
            Cancel
          </Button>
        </div>
      </FormCard>
    </>
  );
}
