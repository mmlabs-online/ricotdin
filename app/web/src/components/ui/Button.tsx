import { forwardRef, type ButtonHTMLAttributes } from 'react'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', className = '', type = 'button', ...props },
  ref,
) {
  return <button ref={ref} type={type} className={`button button-${variant} ${className}`.trim()} {...props} />
})
