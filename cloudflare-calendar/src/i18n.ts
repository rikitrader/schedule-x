export type Locale = 'es' | 'en'

// Spanish values are the original MiPolitico strings; keep them byte-identical.
const es = {
  skip: 'Saltar al calendario', brandSub: 'Calendario', workspaceLabel: 'Espacio', departmentLabel: 'Departamento', allDepartments: 'Todos los departamentos', readOnly: 'Solo lectura', newEvent: 'Nuevo evento', manage: 'Administrar', admin: 'Administración',
  introEyebrow: 'Agenda pública', pageTitle: 'Calendario {brand}', intro: 'Organiza reuniones, eventos y actividades desde un servicio independiente en Cloudflare.', categories: 'Categorías', public: 'Público', team: 'Equipo', private: 'Privado',
  close: 'Cerrar', secureAccess: 'Acceso seguro', authTitle: 'Administrar calendario', password: 'Contraseña', login: 'Iniciar sesión', agenda: 'Agenda', event: 'Evento',
  title: 'Título', start: 'Inicio', end: 'Fin', allDay: 'Evento de todo el día', category: 'Categoría', department: 'Departamento', location: 'Ubicación', description: 'Descripción', delete: 'Eliminar', cancel: 'Cancelar', save: 'Guardar',
  signInToEdit: 'Inicia sesión para modificar eventos.', eventUpdated: 'Evento actualizado.', eventCreated: 'Evento creado.', eventDeleted: 'Evento eliminado.', unexpected: 'Ocurrió un error inesperado.', adminMode: 'Modo administrador', signOut: 'Cerrar sesión',
  newEventTitle: 'Nuevo evento', editEvent: 'Editar evento', sessionClosed: 'Sesión cerrada.', sessionStarted: 'Sesión iniciada.', confirmDelete: '¿Eliminar este evento permanentemente?', signInRequired: 'Inicia sesión para ver el calendario.',
  invalidEvent: 'Evento inválido.', invalidTitle: 'El título debe tener entre 1 y 200 caracteres.', invalidRange: 'El rango de fechas no es válido.', invalidCategory: 'La categoría no es válida.', tooLong: 'El contenido supera el límite permitido.', invalidDate: 'El formato de fecha no es válido.', mustBeJson: 'El contenido debe ser JSON.',
  authRequired: 'Autenticación requerida.', forbidden: 'Acceso denegado.', notFound: 'Evento no encontrado.', badOrigin: 'Origen no autorizado.', routeNotFound: 'Ruta no encontrada.',
  invalidDepartment: 'El departamento no es válido.',
} as const

export type MessageKey = keyof typeof es

const en: Record<MessageKey, string> = {
  skip: 'Skip to calendar', brandSub: 'Calendar', workspaceLabel: 'Workspace', departmentLabel: 'Department', allDepartments: 'All departments', readOnly: 'Read only', newEvent: 'New event', manage: 'Sign in', admin: 'Admin',
  introEyebrow: 'Team schedule', pageTitle: '{brand} Calendar', intro: 'Department calendars for meetings, jobs, and appointments, kept in sync with the CRM.', categories: 'Categories', public: 'Public', team: 'Team', private: 'Private',
  close: 'Close', secureAccess: 'Employee access', authTitle: 'Sign in to the calendar', password: 'Password', login: 'Sign in', agenda: 'Schedule', event: 'Event',
  title: 'Title', start: 'Start', end: 'End', allDay: 'All-day event', category: 'Category', department: 'Department', location: 'Location', description: 'Description', delete: 'Delete', cancel: 'Cancel', save: 'Save',
  signInToEdit: 'Sign in to edit events.', eventUpdated: 'Event updated.', eventCreated: 'Event created.', eventDeleted: 'Event deleted.', unexpected: 'An unexpected error occurred.', adminMode: 'Signed in', signOut: 'Sign out',
  newEventTitle: 'New event', editEvent: 'Edit event', sessionClosed: 'Signed out.', sessionStarted: 'Signed in.', confirmDelete: 'Delete this event permanently?', signInRequired: 'Sign in to view the calendar.',
  invalidEvent: 'Invalid event.', invalidTitle: 'The title must be 1 to 200 characters.', invalidRange: 'The date range is not valid.', invalidCategory: 'The category is not valid.', tooLong: 'The content exceeds the allowed limit.', invalidDate: 'The date format is not valid.', mustBeJson: 'The request body must be JSON.',
  authRequired: 'Sign-in required.', forbidden: 'Access denied.', notFound: 'Event not found.', badOrigin: 'Origin not allowed.', routeNotFound: 'Route not found.',
  invalidDepartment: 'The department is not valid.',
}

export const messages: Record<Locale, Record<MessageKey, string>> = { es, en }
export function t(locale: Locale, key: MessageKey, brand = '') { return messages[locale][key].replaceAll('{brand}', brand) }
export function isMessageKey(value: string): value is MessageKey { return Object.hasOwn(es, value) }
