/* ============================================================
   CONFIG
   Replace with your own Supabase project credentials. The anon
   key is safe to expose client-side — RLS policies (schema.sql)
   define what it's actually allowed to do.
   ============================================================ */
const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';

const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ============================================================
   DOM REFERENCES
   ============================================================ */
const listEl = document.getElementById('notes-list');
const formEl = document.getElementById('create-form');
const titleInput = document.getElementById('new-title');
const contentInput = document.getElementById('new-content');
const statusEl = document.getElementById('connection-status');
const toastEl = document.getElementById('toast');

/* ============================================================
   STATE
   notesCache mirrors the server. While a note is being edited,
   its text lives in editingDraft (not in notesCache), so an
   incoming realtime update can never silently overwrite text
   the user is mid-typing.
   ============================================================ */
let notesCache = [];
let editingNoteId = null;
let editingBaselineUpdatedAt = null; // updated_at the editor started from
let editingDraft = { title: '', content: '' };

/* ============================================================
   DATA LAYER — every SQL/Supabase call lives here
   ============================================================ */

async function fetchNotes() {
  const { data, error } = await db
    .from('notes')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

async function createNote(title, content) {
  const { data, error } = await db
    .from('notes')
    .insert({ title, content })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Optimistic concurrency: the WHERE clause filters on BOTH id
// and the updated_at the editor last saw (knownUpdatedAt). If
// another client changed the row in between, updated_at no
// longer matches, zero rows match the filter, and Supabase
// returns an empty array instead of an error — that's the
// conflict signal this whole app is built around.
async function updateNote(id, title, content, knownUpdatedAt) {
  const { data, error } = await db
    .from('notes')
    .update({ title, content })
    .eq('id', id)
    .eq('updated_at', knownUpdatedAt)
    .select();
  if (error) throw error;
  return data.length === 0 ? null : data[0]; // null = conflict
}

async function deleteNote(id) {
  const { data, error } = await db
    .from('notes')
    .delete()
    .eq('id', id)
    .select();
  if (error) throw error;
  return data.length > 0; // false if already gone
}

/* ============================================================
   REALTIME — keeps every open tab in sync with the database
   ============================================================ */
function subscribeToNotes() {
  db.channel('notes-changes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'notes' },
      handleRealtimeChange
    )
    .subscribe((status) => {
      statusEl.textContent = status === 'SUBSCRIBED' ? 'Live' : 'Connecting…';
    });
}

function handleRealtimeChange({ eventType, new: newRow, old: oldRow }) {
  if (eventType === 'INSERT') {
    if (!notesCache.some(n => n.id === newRow.id)) notesCache.push(newRow);
  }

  if (eventType === 'UPDATE') {
    const idx = notesCache.findIndex(n => n.id === newRow.id);
    if (idx !== -1) notesCache[idx] = newRow;

    // This is the note this exact tab has open for editing, and
    // it just changed underneath that edit. Don't touch the
    // draft — just warn. The eventual Save will hit the
    // conflict path in updateNote() and resolve cleanly.
    if (editingNoteId === newRow.id && newRow.updated_at !== editingBaselineUpdatedAt) {
      showToast(`"${newRow.title || 'Untitled'}" was changed in another tab while you're editing it.`);
    }
  }

  if (eventType === 'DELETE') {
    notesCache = notesCache.filter(n => n.id !== oldRow.id);
    if (editingNoteId === oldRow.id) {
      cancelEdit();
      showToast('The note you were editing was deleted elsewhere.');
    }
  }

  render();
}

/* ============================================================
   RENDER LAYER — pure DOM building from current state
   ============================================================ */
function render() {
  listEl.innerHTML = '';
  notesCache.forEach(note => {
    listEl.appendChild(
      note.id === editingNoteId ? renderEditCard(note) : renderViewCard(note)
    );
  });
}

function renderViewCard(note) {
  const card = document.createElement('div');
  card.className = 'note-card';
  card.dataset.id = note.id;
  card.innerHTML = `
    <h3>${escapeHtml(note.title) || '(untitled)'}</h3>
    <p>${escapeHtml(note.content)}</p>
    <small>Updated ${new Date(note.updated_at).toLocaleString()}</small>
    <div class="actions">
      <button data-action="edit">Edit</button>
      <button data-action="delete" class="danger">Delete</button>
    </div>
  `;
  return card;
}

function renderEditCard(note) {
  const card = document.createElement('div');
  card.className = 'note-card editing';
  card.dataset.id = note.id;

  const titleField = document.createElement('input');
  titleField.value = editingDraft.title;
  titleField.placeholder = 'Title';
  titleField.addEventListener('input', e => editingDraft.title = e.target.value);

  const contentField = document.createElement('textarea');
  contentField.rows = 3;
  contentField.value = editingDraft.content;
  contentField.placeholder = 'Content';
  contentField.addEventListener('input', e => editingDraft.content = e.target.value);

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.innerHTML = `
    <button data-action="save">Save</button>
    <button data-action="cancel">Cancel</button>
  `;

  card.append(titleField, contentField, actions);
  return card;
}

function escapeHtml(str = '') {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('visible');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.remove('visible'), 4000);
}

/* ============================================================
   EVENT HANDLERS
   ============================================================ */
formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = titleInput.value.trim();
  const content = contentInput.value.trim();
  if (!title && !content) return;
  try {
    const note = await createNote(title, content);
    // Realtime will also deliver this INSERT; the guard in
    // handleRealtimeChange prevents a duplicate, so adding it
    // here too just makes the new note appear instantly.
    if (!notesCache.some(n => n.id === note.id)) notesCache.push(note);
    render();
    formEl.reset();
  } catch (err) {
    showToast(`Could not create note: ${err.message}`);
  }
});

listEl.addEventListener('click', async (e) => {
  const button = e.target.closest('button');
  if (!button) return;
  const card = button.closest('.note-card');
  const id = card.dataset.id;

  if (button.dataset.action === 'edit') startEdit(id);
  if (button.dataset.action === 'cancel') cancelEdit();
  if (button.dataset.action === 'save') await saveEdit(id);
  if (button.dataset.action === 'delete') await handleDelete(id);
});

function startEdit(id) {
  const note = notesCache.find(n => n.id === id);
  if (!note) return;
  editingNoteId = id;
  editingBaselineUpdatedAt = note.updated_at;
  editingDraft = { title: note.title, content: note.content };
  render();
}

function cancelEdit() {
  editingNoteId = null;
  editingBaselineUpdatedAt = null;
  render();
}

async function saveEdit(id) {
  try {
    const result = await updateNote(
      id,
      editingDraft.title.trim(),
      editingDraft.content.trim(),
      editingBaselineUpdatedAt
    );

    if (result === null) {
      // Conflict: someone else's write landed first. Pull the
      // latest row and let the user redo their edit on top of it
      // rather than silently losing or overwriting either side.
      notesCache = await fetchNotes();
      showToast('Save failed: this note changed elsewhere. Showing the latest version — please re-apply your edit.');
      cancelEdit();
      return;
    }

    const idx = notesCache.findIndex(n => n.id === id);
    if (idx !== -1) notesCache[idx] = result;
    cancelEdit();
  } catch (err) {
    showToast(`Could not save note: ${err.message}`);
  }
}

async function handleDelete(id) {
  if (!confirm('Delete this note?')) return;
  try {
    const stillExisted = await deleteNote(id);
    notesCache = notesCache.filter(n => n.id !== id);
    if (!stillExisted) showToast('Note was already deleted elsewhere.');
    if (editingNoteId === id) cancelEdit();
    render();
  } catch (err) {
    showToast(`Could not delete note: ${err.message}`);
  }
}

/* ============================================================
   INIT
   ============================================================ */
async function init() {
  try {
    notesCache = await fetchNotes();
    render();
    subscribeToNotes();
  } catch (err) {
    showToast(`Could not load notes: ${err.message}`);
  }
}

init();
