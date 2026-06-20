import { AnimatePresence } from 'framer-motion';
import styled from 'styled-components';
import { Data } from '../../data/data';
import { ConvoHub } from '../../session/conversations';
import {
  AccountCreation,
  AccountRestoration,
  Onboarding,
} from '../../state/onboarding/ducks/registration';
import {
  useOnboardAccountCreationStep,
  useOnboardAccountRestorationStep,
  useOnboardStep,
} from '../../state/onboarding/selectors/registration';
import { Storage } from '../../util/storage';
import { Flex } from '../basic/Flex';
import { SpacerXL } from '../basic/Text';
import { OnboardContainer } from './components';
import { CreateAccount, RestoreAccount, Start } from './stages';
import { SnodePool } from '../../session/apis/snode_api/snodePool';

export async function resetRegistration() {
  await Data.removeAll();
  Storage.reset();
  await Storage.fetch();
  ConvoHub.use().reset();
  await ConvoHub.use().load();
  // prefetch snodes list from the network
  void SnodePool.getSnodePoolFromDBOrFetchFromSeed();
}

const StyledRegistrationContainer = styled(Flex)`
  width: 348px;
  .session-button {
    width: 100%;
    margin: 0;
  }
`;

export const RegistrationStages = () => {
  const step = useOnboardStep();
  const creationStep = useOnboardAccountCreationStep();
  const restorationStep = useOnboardAccountRestorationStep();

  return (
    <AnimatePresence>
      <StyledRegistrationContainer $container={true} $flexDirection="column">
        <Flex $container={true} $alignItems="center" height={'40px'}>
          <img src="images/session/session_icon.svg" alt="Apocentro" height={40} width={40} />
          <div style={{ flexGrow: 1 }} />
        </Flex>

        <Flex $container={true} $flexDirection="column" $alignItems="center">
          <SpacerXL />
          <OnboardContainer
            key={`${Onboarding[step]}-${step === Onboarding.CreateAccount ? AccountCreation[creationStep] : AccountRestoration[restorationStep]}`}
            animate={
              step !== Onboarding.Start &&
              restorationStep !== AccountRestoration.Finishing &&
              restorationStep !== AccountRestoration.Finished &&
              restorationStep !== AccountRestoration.Complete
            }
          >
            {step === Onboarding.Start ? <Start /> : null}
            {step === Onboarding.CreateAccount ? <CreateAccount /> : null}
            {step === Onboarding.RestoreAccount ? <RestoreAccount /> : null}
          </OnboardContainer>
        </Flex>
      </StyledRegistrationContainer>
    </AnimatePresence>
  );
};
