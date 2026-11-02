"""Invoices, money and payment notifications."""
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import hmac


def invoice_total(lines, tax_rate):
    subtotal = sum(Decimal(str(line['price'])) * line['quantity'] for line in lines)
    tax = (subtotal * Decimal(str(tax_rate))).quantize(Decimal('.01'), rounding=ROUND_HALF_UP)
    return {'subtotal': subtotal, 'tax': tax, 'total': subtotal + tax}


def validate_webhook_signature(body, signature, secret):
    """Authenticate an incoming payment provider notification before processing."""
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, expected)


def record_payment_once(database, event):
    """Provider retries must not charge the customer or credit an invoice twice."""
    with database.transaction():
        if database.has_event(event.id):
            return False
        database.mark_invoice_paid(event.invoice_id, event.amount)
        database.insert_event(event.id)
    return True


def refund_payment(gateway, payment, amount):
    if amount <= 0 or amount > payment.remaining_refundable:
        raise ValueError('Refund exceeds available balance')
    return gateway.refund(payment.id, amount)
