import { SelectWidget } from '../../ui';
import styles from './InputArea.module.css';
import type { ElicitationField, ElicitationForm as ElicitationFormModel, ElicitationValues } from './elicitation-schema';

function textWithFallback(key: string, fallback: string) {
  const translated = window.t?.(key);
  return translated && translated !== key ? translated : fallback;
}

interface ElicitationFormProps {
  form: ElicitationFormModel;
  values: ElicitationValues;
  message: string;
  busy: boolean;
  /** Keys of required fields the user has been told about, after a blocked submit. */
  missingKeys: ReadonlySet<string>;
  onChange: (key: string, value: string | boolean) => void;
}

/** The fields a server asked for, grouped as its schema described them. */
export function ElicitationForm({
  form,
  values,
  message,
  busy,
  missingKeys,
  onChange,
}: ElicitationFormProps) {
  const renderField = (field: ElicitationField) => {
    const missing = missingKeys.has(field.key);
    const label = field.required ? `${field.label} *` : field.label;
    return (
      <div key={field.key} className={styles['session-confirmation-field']}>
        <span className={styles['session-confirmation-field-label']}>{label}</span>
        {field.type === 'boolean' ? (
          <input
            type="checkbox"
            aria-label={field.label}
            className={styles['session-confirmation-field-checkbox']}
            checked={values[field.key] === true}
            disabled={busy}
            onChange={(event) => onChange(field.key, event.target.checked)}
          />
        ) : field.type === 'enum' ? (
          <SelectWidget
            value={typeof values[field.key] === 'string' ? (values[field.key] as string) : ''}
            disabled={busy}
            density="compact"
            placeholder={textWithFallback('approval.mcpElicitation.choose', '请选择')}
            onChange={(value) => onChange(field.key, value)}
            options={(field.options || []).map(option => ({ value: option.value, label: option.label }))}
          />
        ) : (
          <input
            type={field.type === 'number' ? 'number' : 'text'}
            aria-label={field.label}
            aria-invalid={missing}
            className={styles['session-confirmation-field-input']}
            value={typeof values[field.key] === 'string' ? (values[field.key] as string) : ''}
            disabled={busy}
            onChange={(event) => onChange(field.key, event.target.value)}
          />
        )}
      </div>
    );
  };

  return (
    <div className={styles['session-confirmation-form']}>
      {message && (
        <div className={styles['session-confirmation-form-message']}>{message}</div>
      )}
      {form.groups.map(group => (
        group.key === '' ? (
          <div key="__root" className={styles['session-confirmation-field-group']}>
            {group.fields.map(renderField)}
          </div>
        ) : (
          <div key={group.key} className={styles['session-confirmation-field-group']}>
            <div className={styles['session-confirmation-field-group-label']}>{group.label}</div>
            {group.fields.map(renderField)}
          </div>
        )
      ))}
      {missingKeys.size > 0 && (
        <div className={styles['session-confirmation-field-required']} role="alert" data-testid="elicitation-required">
          {textWithFallback('approval.mcpElicitation.requiredMissing', '请填写标有 * 的必填项')}
        </div>
      )}
      {form.unsupported.length > 0 && (
        <div
          className={styles['session-confirmation-field-unsupported']}
          data-testid="elicitation-unsupported"
        >
          {textWithFallback('approval.mcpElicitation.unsupportedField', '暂不支持的字段类型')}
          {`: ${form.unsupported.join(', ')}`}
        </div>
      )}
    </div>
  );
}
