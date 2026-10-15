"""Trusted local operator command. Never expose this command as an agent tool."""
import argparse

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--request-id',required=True)
    parser.add_argument('--user-id',required=True)
    parser.add_argument('--ttl',type=float,default=300)
    args=parser.parse_args()
    from src.tools.app import store
    from src.policy.approvals import ApprovalStore
    ApprovalStore(store).approve(args.request_id,args.user_id,args.ttl)
    print('Approval recorded. Resume by submitting the identical action through the gateway.')

if __name__=='__main__':main()
