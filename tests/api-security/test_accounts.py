"""TB-039 accounts: sign-up, verification, sign-in, lockout, password reset and change, enumeration resistance."""
from conftest import PASSWORD, SCRIPTED


def test_signup_needs_a_valid_address_and_a_strong_password(world):
    u = world.user('u').guest()
    assert u.post('/api/auth/signup', json={'email': 'not-an-email', 'password': PASSWORD}).status_code == 400
    assert u.post('/api/auth/signup', json={'email': 'carol@example.invalid', 'password': 'short'}).status_code == 400
    assert u.post('/api/auth/signup', json={'email': 'carol@example.invalid', 'password': 'carol-carol-carol-1'}).status_code == 400  # contains the email name
    assert u.post('/api/auth/signup', json={'email': 'carol@example.invalid', 'password': 'aaaaaaaaaaaaaaaa'}).status_code == 400  # repetitive


def test_signup_does_not_reveal_whether_an_address_is_registered(world):
    world.account('alice', 'alice@example.invalid')
    a = world.user('a').guest().post('/api/auth/signup', json={'email': 'alice@example.invalid', 'password': 'another strong passphrase 7'})
    b = world.user('b').guest().post('/api/auth/signup', json={'email': 'nobody@example.invalid', 'password': 'another strong passphrase 7'})
    assert a.status_code == b.status_code == 201 and a.json() == b.json()
    assert any('already has one' in m['body'] for m in world.outbox() if m['to'] == 'alice@example.invalid')  # the owner is told by email
    f1 = world.user('c').post('/api/auth/password/forgot', json={'email': 'alice@example.invalid'})
    f2 = world.user('d').post('/api/auth/password/forgot', json={'email': 'nobody2@example.invalid'})
    assert f1.json() == f2.json()


def test_an_account_starts_from_its_verification_link_and_claims_the_guest_runs(world):
    u = world.user('dave').guest()
    guest_run = u.run()['id']
    u.post('/api/auth/signup', json={'email': 'dave@example.invalid', 'password': PASSWORD})
    r = world.user('x').post('/api/auth/login', json={'email': 'dave@example.invalid', 'password': PASSWORD})
    assert r.status_code == 403 and 'verify' in r.json()['detail']  # unverified: only said after the right password
    token = world.link_token('dave@example.invalid', 'verify')
    v = u.post('/api/auth/verify', json={'token': token})
    assert v.status_code == 200 and v.json()['claimed_runs'] == 1 and v.json()['account']['verified']
    u.use(v.json()['token'])
    assert u.get(f'/api/runs/{guest_run}').status_code == 200
    assert u.post('/api/auth/verify', json={'token': token}).status_code == 400  # single use
    assert u.get('/api/auth/me').json()['kind'] == 'account'


def test_wrong_passwords_lock_the_account_without_revealing_it(world):
    world.account('erin', 'erin@example.invalid')
    attacker = world.user('attacker')
    answers = {attacker.post('/api/auth/login', json={'email': 'erin@example.invalid', 'password': f'guess number {i} xx'}).json()['detail'] for i in range(5)}
    unknown = attacker.post('/api/auth/login', json={'email': 'ghost@example.invalid', 'password': 'guess number 9 xx'}).json()['detail']
    assert answers == {unknown} == {'wrong email or password'}
    locked = attacker.post('/api/auth/login', json={'email': 'erin@example.invalid', 'password': PASSWORD})
    assert locked.status_code == 401 and 'too many failed' in locked.json()['detail']  # even the right password waits out the lock
    assert attacker.post('/api/auth/login', json={'email': 'erin@example.invalid', 'password': 'still guessing 10'}).json()['detail'] == 'wrong email or password'


def test_password_reset_is_single_use_and_signs_out_everywhere(world):
    frank = world.account('frank', 'frank@example.invalid')
    rid = frank.run()['id']
    world.user('x').post('/api/auth/password/forgot', json={'email': 'frank@example.invalid'})
    token = world.link_token('frank@example.invalid', 'reset')
    assert world.user('y').post('/api/auth/password/reset', json={'token': token, 'password': 'short'}).status_code == 400
    token = (world.user('x').post('/api/auth/password/forgot', json={'email': 'frank@example.invalid'}), world.link_token('frank@example.invalid', 'reset'))[1]
    new = 'a brand new passphrase 2026'
    assert world.user('y').post('/api/auth/password/reset', json={'token': token, 'password': new}).status_code == 200
    assert world.user('y').post('/api/auth/password/reset', json={'token': token, 'password': new}).status_code == 400
    assert frank.get('/api/runs').status_code == 401  # old session revoked
    assert world.user('z').post('/api/auth/login', json={'email': 'frank@example.invalid', 'password': PASSWORD}).status_code == 401
    again = world.user('z')
    again.use(again.post('/api/auth/login', json={'email': 'frank@example.invalid', 'password': new}).json()['token'])
    assert again.get(f'/api/runs/{rid}').status_code == 200  # the account's runs survive a reset


def test_password_change_needs_the_current_password_and_signs_out_other_devices(world):
    laptop = world.account('gina', 'gina@example.invalid')
    phone = world.user('phone')
    phone.use(phone.post('/api/auth/login', json={'email': 'gina@example.invalid', 'password': PASSWORD}).json()['token'])
    assert laptop.post('/api/auth/password/change', json={'current_password': 'wrong one entirely', 'new_password': 'a new long passphrase 77'}).status_code == 401
    assert laptop.post('/api/auth/password/change', json={'current_password': PASSWORD, 'new_password': 'a new long passphrase 77'}).status_code == 200
    assert laptop.get('/api/runs').status_code == 200 and phone.get('/api/runs').status_code == 401


def test_signing_out_ends_only_that_session(world):
    a = world.account('hal', 'hal@example.invalid')
    rid = a.run()['id']
    assert a.delete('/api/session').json() == {'signed_out': True}
    assert a.get('/api/runs').status_code == 401
    b = world.user('hal2')
    b.use(b.post('/api/auth/login', json={'email': 'hal@example.invalid', 'password': PASSWORD}).json()['token'])
    assert b.get(f'/api/runs/{rid}').status_code == 200
