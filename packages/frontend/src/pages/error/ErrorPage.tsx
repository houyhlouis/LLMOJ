import React, { useEffect } from "react";
import { Message, Icon } from "semantic-ui-react";
import { observer } from "mobx-react";

import style from "./ErrorPage.module.less";

import { useLocalizer, useNavigationChecked } from "@/utils/hooks";
import { appState } from "@/appState";
import { isToBeLocalizedText, ToBeLocalizedText } from "@/locales";
import { EmojiRenderer } from "@/components/EmojiRenderer";
import PseudoLink from "@/components/PseudoLink";

export interface ErrorPageProps {
  uncaughtError?: Error;
  message: React.ReactNode | ToBeLocalizedText;
  options: {
    showRefresh?: true;
    showBack?: true;
  };
  onRecover?: () => void;
}

let ErrorPage: React.FC<ErrorPageProps> = props => {
  const _ = useLocalizer("error");
  const navigation = useNavigationChecked();

  useEffect(() => {
    appState.enterNewPage(_(".title"));
  }, [appState.locale]);

  if (props.uncaughtError) console.error(props.uncaughtError);

  return (
    <Message className={style.message} icon error role="alert">
      <Icon name="remove" />
      <EmojiRenderer>
        <Message.Content>
          <Message.Header>{_(props.uncaughtError ? ".unexpected_error" : ".error")}</Message.Header>
          {props.uncaughtError ? (
            <>
              <p>{_(".unexpected_error_description")}</p>
              <p>
                {/* These errors could not be recovered. The page must be reloaded. */}
                <PseudoLink onClick={() => location.reload()}>{_(".refresh")}</PseudoLink>
              </p>
            </>
          ) : (
            <>
              <p>{isToBeLocalizedText(props.message) ? props.message(_) : props.message}</p>
              <p>
                {props.options.showBack && (
                  <PseudoLink
                    onClick={() => {
                      if (props.onRecover) props.onRecover();
                      navigation.goBack();
                    }}
                  >
                    {_(".back")}
                  </PseudoLink>
                )}
                {props.options.showRefresh && (
                  <PseudoLink
                    onClick={() => {
                      if (props.onRecover) props.onRecover();
                      navigation.refresh();
                    }}
                  >
                    {_(".refresh")}
                  </PseudoLink>
                )}
              </p>
            </>
          )}
        </Message.Content>
      </EmojiRenderer>
    </Message>
  );
};

export default observer(ErrorPage);
